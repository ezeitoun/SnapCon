// connectors/h264-fmp4.js — H.264 over RTP in, fragmented MP4 out, no
// external tools. Used by connectors/bambu-camera.js to relay a Bambu Lab
// printer's RTSP camera to the browser as a live <video>.
//
// Why fragmented MP4 and not WebCodecs: SnapCon is normally opened as plain
// http://<lan-ip>:4545, which is not a "secure context", and WebCodecs'
// VideoDecoder only exists in secure contexts. Media Source Extensions do not
// have that restriction, and every current browser decodes H.264 inside an
// fMP4 byte stream. The server never decodes a pixel: it only re-wraps the
// camera's own H.264 access units, so relaying costs almost no CPU.
//
// Three pure pieces, each unit-tested:
//   - H264Depacketizer  RTP payloads (RFC 6184: single NAL, STAP-A, FU-A)
//                       -> access units { nals[], timestamp, key }
//   - parseSps          width/height/profile/level from a sequence parameter set
//   - Fmp4Muxer         init segment (ftyp+moov) + one moof/mdat per frame

// ---- NAL helpers ----
const NAL = { SLICE: 1, IDR: 5, SEI: 6, SPS: 7, PPS: 8, AUD: 9, STAP_A: 24, FU_A: 28 };
const nalType = (nal) => nal[0] & 0x1f;

// ---- RTP ----
// Returns { marker, payloadType, seq, timestamp, payload } or null for a
// packet that is not RTP version 2 / is truncated.
function parseRtp(buf) {
  if (!buf || buf.length < 12 || (buf[0] >> 6) !== 2) return null;
  const padding = (buf[0] & 0x20) !== 0;
  const extension = (buf[0] & 0x10) !== 0;
  const csrcCount = buf[0] & 0x0f;
  let offset = 12 + csrcCount * 4;
  if (extension) {
    if (buf.length < offset + 4) return null;
    offset += 4 + buf.readUInt16BE(offset + 2) * 4;
  }
  let end = buf.length;
  if (padding) end -= buf[buf.length - 1];
  if (offset > end) return null;
  return {
    marker: (buf[1] & 0x80) !== 0,
    payloadType: buf[1] & 0x7f,
    seq: buf.readUInt16BE(2),
    timestamp: buf.readUInt32BE(4),
    payload: buf.subarray(offset, end)
  };
}

// Reassembles NAL units from RTP payloads and groups them into access units
// (one video frame). A frame ends on the RTP marker bit, or — for a sender
// that does not set it — when the timestamp moves on. A fragmented NAL that
// loses a piece (sequence gap) is dropped rather than emitted corrupt; the
// decoder recovers at the next keyframe.
class H264Depacketizer {
  constructor(onAccessUnit) {
    this.onAccessUnit = onAccessUnit;
    this.nals = [];
    this.timestamp = null;
    this.fu = null;        // { header, parts[] } while a FU-A is in flight
    this.lastSeq = null;
  }

  push(pkt) {
    if (!pkt) return;
    if (this.lastSeq != null && ((this.lastSeq + 1) & 0xffff) !== pkt.seq) this.fu = null; // loss mid-fragment
    this.lastSeq = pkt.seq;
    if (this.timestamp != null && pkt.timestamp !== this.timestamp && this.nals.length) this._flush();
    this.timestamp = pkt.timestamp;
    const p = pkt.payload;
    if (!p.length) return;
    const type = p[0] & 0x1f;
    if (type >= 1 && type <= 23) {
      this.nals.push(Buffer.from(p));
    } else if (type === NAL.STAP_A) {
      let o = 1;
      while (o + 2 <= p.length) {
        const size = p.readUInt16BE(o); o += 2;
        if (!size || o + size > p.length) break;
        this.nals.push(Buffer.from(p.subarray(o, o + size)));
        o += size;
      }
    } else if (type === NAL.FU_A && p.length > 2) {
      const start = (p[1] & 0x80) !== 0, end = (p[1] & 0x40) !== 0;
      if (start) this.fu = { header: (p[0] & 0xe0) | (p[1] & 0x1f), parts: [] };
      if (this.fu) {
        this.fu.parts.push(p.subarray(2));
        if (end) {
          this.nals.push(Buffer.concat([Buffer.from([this.fu.header]), ...this.fu.parts]));
          this.fu = null;
        }
      }
    }
    // Other packetizations (STAP-B, MTAP, FU-B) are interleaved-mode only and
    // are not used by a camera streaming in single-NAL / non-interleaved mode.
    if (pkt.marker) this._flush();
  }

  _flush() {
    if (!this.nals.length) return;
    const nals = this.nals;
    this.nals = [];
    this.onAccessUnit({ nals, timestamp: this.timestamp, key: nals.some(n => nalType(n) === NAL.IDR) });
  }
}

// ---- SPS ----
function unescapeRbsp(nal) {
  const out = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0 && i + 1 < nal.length && nal[i + 1] <= 3) continue;
    out.push(nal[i]);
  }
  return Buffer.from(out);
}

class BitReader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  u(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.buf[this.pos >> 3];
      if (byte === undefined) throw new Error("SPS truncated");
      v = v * 2 + ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
  ue() {
    let zeros = 0;
    while (this.u(1) === 0) { if (++zeros > 31) throw new Error("bad exp-Golomb code"); }
    return (2 ** zeros - 1) + (zeros ? this.u(zeros) : 0);
  }
  se() { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -(k / 2); }
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

// Everything the MP4 sample description and the browser's codec string need.
function parseSps(nal) {
  const r = new BitReader(unescapeRbsp(nal.subarray(1)));
  const profile = r.u(8), constraints = r.u(8), level = r.u(8);
  r.ue(); // seq_parameter_set_id
  let chromaFormat = 1, bitDepthLuma = 8, bitDepthChroma = 8;
  if (HIGH_PROFILES.has(profile)) {
    chromaFormat = r.ue();
    if (chromaFormat === 3) r.u(1);
    bitDepthLuma = r.ue() + 8;
    bitDepthChroma = r.ue() + 8;
    r.u(1); // qpprime_y_zero_transform_bypass_flag
    if (r.u(1)) { // seq_scaling_matrix_present_flag
      for (let i = 0; i < (chromaFormat !== 3 ? 8 : 12); i++) {
        if (!r.u(1)) continue;
        const size = i < 6 ? 16 : 64;
        let last = 8, next = 8;
        for (let j = 0; j < size; j++) {
          if (next !== 0) next = (last + r.se() + 256) % 256;
          last = next === 0 ? last : next;
        }
      }
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) {
    r.u(1); r.se(); r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.u(1); // gaps_in_frame_num_value_allowed_flag
  const widthMbs = r.ue() + 1;
  const heightMapUnits = r.ue() + 1;
  const frameMbsOnly = r.u(1);
  if (!frameMbsOnly) r.u(1);
  r.u(1); // direct_8x8_inference_flag
  let cropL = 0, cropR = 0, cropT = 0, cropB = 0;
  if (r.u(1)) { cropL = r.ue(); cropR = r.ue(); cropT = r.ue(); cropB = r.ue(); }
  const subW = chromaFormat === 1 || chromaFormat === 2 ? 2 : 1;
  const subH = chromaFormat === 1 ? 2 : 1;
  const cropUnitX = chromaFormat === 0 ? 1 : subW;
  const cropUnitY = (chromaFormat === 0 ? 1 : subH) * (2 - frameMbsOnly);
  const hex = (n) => n.toString(16).padStart(2, "0");
  const width = widthMbs * 16 - (cropL + cropR) * cropUnitX;
  const height = (2 - frameMbsOnly) * heightMapUnits * 16 - (cropT + cropB) * cropUnitY;
  // The MP4 sample entry stores 16-bit dimensions; anything outside a sane
  // camera range is a corrupt SPS, not a real picture size.
  if (!(width > 0 && height > 0 && width <= 8192 && height <= 8192)) throw new Error("implausible picture size in SPS: " + width + "x" + height);
  return {
    profile, constraints, level, chromaFormat, bitDepthLuma, bitDepthChroma,
    width, height,
    codec: "avc1." + hex(profile) + hex(constraints) + hex(level)
  };
}

// ---- MP4 boxes ----
function box(type, ...parts) {
  const payload = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length + 8, 0);
  head.write(type, 4, "ascii");
  return Buffer.concat([head, payload]);
}
function fullBox(type, version, flags, ...parts) {
  const vf = Buffer.alloc(4);
  vf.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff), 0);
  return box(type, vf, ...parts);
}
const u8 = (...v) => Buffer.from(v);
function u16(v) { const b = Buffer.alloc(2); b.writeUInt16BE(v, 0); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0, 0); return b; }
function u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(v), 0); return b; }
const MATRIX = Buffer.concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);
const TIMESCALE = 90000; // RTP's H.264 clock, kept as-is so no timestamp is ever rescaled

function avcC(sps, pps, info) {
  const parts = [
    u8(1, sps[1], sps[2], sps[3], 0xff, 0xe0 | 1), u16(sps.length), sps,
    u8(1), u16(pps.length), pps
  ];
  // ISO/IEC 14496-15: High-family profiles carry chroma format and bit depth.
  if ([100, 110, 122, 144].includes(info.profile)) {
    parts.push(u8(0xfc | (info.chromaFormat & 3), 0xf8 | ((info.bitDepthLuma - 8) & 7), 0xf8 | ((info.bitDepthChroma - 8) & 7), 0));
  }
  return box("avcC", ...parts);
}

function initSegment(sps, pps) {
  const info = parseSps(sps);
  const { width, height } = info;
  const ftyp = box("ftyp", Buffer.from("isom"), u32(0x200), Buffer.from("isomiso2iso5avc1mp41"));
  const mvhd = fullBox("mvhd", 0, 0, u32(0), u32(0), u32(1000), u32(0), u32(0x00010000), u16(0x0100), Buffer.alloc(10), MATRIX, Buffer.alloc(24), u32(2));
  const tkhd = fullBox("tkhd", 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0), Buffer.alloc(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(width << 16), u32(height << 16));
  const mdhd = fullBox("mdhd", 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(0), u16(0x55c4), u16(0));
  const hdlr = fullBox("hdlr", 0, 0, u32(0), Buffer.from("vide"), Buffer.alloc(12), Buffer.from("SnapCon Video\0"));
  const vmhd = fullBox("vmhd", 0, 1, Buffer.alloc(8));
  const dinf = box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));
  const compressor = Buffer.alloc(32);
  const avc1 = box("avc1",
    Buffer.alloc(6), u16(1), u16(0), u16(0), Buffer.alloc(12),
    u16(width), u16(height), u32(0x00480000), u32(0x00480000), u32(0), u16(1), compressor, u16(0x0018), u16(0xffff),
    avcC(sps, pps, info));
  const stbl = box("stbl",
    fullBox("stsd", 0, 0, u32(1), avc1),
    fullBox("stts", 0, 0, u32(0)), fullBox("stsc", 0, 0, u32(0)),
    fullBox("stsz", 0, 0, u32(0), u32(0)), fullBox("stco", 0, 0, u32(0)));
  const trak = box("trak", tkhd, box("mdia", mdhd, hdlr, box("minf", vmhd, dinf, stbl)));
  const mvex = box("mvex", fullBox("trex", 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)));
  return { buffer: Buffer.concat([ftyp, box("moov", mvhd, trak, mvex)]), info };
}

// One frame -> one moof+mdat. `nals` are raw NAL units (no start codes); they
// are written length-prefixed (AVCC), which is what the sample entry's avcC
// (lengthSizeMinusOne = 3) declares. Access unit delimiters are dropped;
// in-band SPS/PPS are kept (allowed, and harmless to the decoder).
function fragment(seq, baseDecodeTime, duration, nals, key) {
  const kept = nals.filter(n => nalType(n) !== NAL.AUD);
  const data = Buffer.concat(kept.flatMap(n => [u32(n.length), n]));
  const flags = key ? 0x02000000 : 0x01010000; // sync sample / non-sync, depends on others
  const trunBody = [u32(1), u32(0), u32(duration), u32(data.length), u32(flags)];
  const build = (dataOffset) => box("moof",
    fullBox("mfhd", 0, 0, u32(seq)),
    box("traf",
      fullBox("tfhd", 0, 0x020000, u32(1)), // default-base-is-moof
      fullBox("tfdt", 1, 0, u64(baseDecodeTime)),
      fullBox("trun", 0, 0x000701, trunBody[0], u32(dataOffset), ...trunBody.slice(2))));
  const moofSize = build(0).length;
  return Buffer.concat([build(moofSize + 8), box("mdat", data)]);
}

// Feeds access units in, gets MP4 bytes out. A frame is written when the NEXT
// one arrives, because an fMP4 sample needs its duration and RTP only tells
// you that by the following timestamp — one frame (~40 ms) of added latency.
class Fmp4Muxer {
  constructor({ onInit, onFragment }) {
    this.onInit = onInit;
    this.onFragment = onFragment;
    this.sps = null; this.pps = null;
    this.init = null;
    this.pending = null;
    this.seq = 1;
    this.lastTs32 = null;
    this.tsBase = null;
    this.ts = 0;           // unwrapped 90 kHz clock, starting at 0
  }

  setParameterSets(sps, pps) {
    if (sps) this.sps = sps;
    if (pps) this.pps = pps;
  }

  _unwrap(ts32) {
    if (this.lastTs32 == null) { this.lastTs32 = ts32; return this.ts; }
    let delta = (ts32 - this.lastTs32) | 0; // signed 32-bit difference survives wrap-around
    this.lastTs32 = ts32;
    this.ts += delta;
    return this.ts;
  }

  push(au) {
    for (const n of au.nals) {
      const t = nalType(n);
      if (t === NAL.SPS) this.sps = n;
      else if (t === NAL.PPS) this.pps = n;
    }
    // Nothing is decodable before the first keyframe with its parameter sets.
    if (!this.init) {
      if (!au.key || !this.sps || !this.pps) return;
      this.init = initSegment(this.sps, this.pps);
      this.onInit(this.init);
    }
    const ts = this._unwrap(au.timestamp);
    const frame = { ...au, ts };
    if (this.pending && frame.ts < this.pending.ts) {
      // RTP carries presentation times. A timestamp going backwards means the
      // encoder uses B-frames (decode order != display order), which would
      // need composition offsets this muxer does not write. Live camera
      // encoders do not do this; refuse loudly rather than feed MSE a
      // decode timeline that runs backwards.
      throw Object.assign(new Error("the camera stream uses B-frames, which SnapCon cannot relay"), { code: "EBFRAMES" });
    }
    if (this.pending) {
      let duration = frame.ts - this.pending.ts;
      if (duration <= 0 || duration > TIMESCALE * 5) duration = 3000; // clock jump: assume 30 fps rather than stall
      this._emit(this.pending, duration);
    }
    this.pending = frame;
  }

  _emit(frame, duration) {
    // A keyframe carries its parameter sets in-band so that a viewer joining
    // at it (and ffmpeg snapshotting it) never depends on an earlier packet.
    let nals = frame.nals;
    if (frame.key && !nals.some(n => nalType(n) === NAL.SPS)) nals = [this.sps, this.pps, ...nals];
    this.onFragment({ buffer: fragment(this.seq++, Math.max(0, frame.ts), duration, nals, frame.key), key: frame.key, nals });
  }
}

// Annex B (00 00 00 01 start codes), the raw elementary-stream form ffmpeg
// reads with `-f h264` — used for the optional JPEG snapshot.
function toAnnexB(nals) {
  const sc = Buffer.from([0, 0, 0, 1]);
  return Buffer.concat(nals.flatMap(n => [sc, n]));
}

// Splits an Annex B stream into NAL units (tests and fixtures).
function splitAnnexB(buf) {
  const nals = [];
  let i = 0, start = -1;
  while (i + 3 <= buf.length) {
    const three = buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1;
    const four = i + 4 <= buf.length && buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1;
    if (three || four) {
      if (start >= 0) nals.push(buf.subarray(start, i));
      i += four ? 4 : 3;
      start = i;
    } else i++;
  }
  if (start >= 0 && start < buf.length) nals.push(buf.subarray(start));
  // Trailing zero bytes before a start code belong to the next start code.
  return nals.map(n => { let e = n.length; while (e > 0 && n[e - 1] === 0) e--; return n.subarray(0, e); }).filter(n => n.length);
}

module.exports = { NAL, nalType, parseRtp, H264Depacketizer, parseSps, initSegment, fragment, Fmp4Muxer, toAnnexB, splitAnnexB, unescapeRbsp, TIMESCALE };
