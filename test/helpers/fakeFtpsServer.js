// test/helpers/fakeFtpsServer.js — a stand-in for the implicit-FTPS server a
// Bambu Lab printer runs on port 990: TLS from the first byte on the control
// connection, TLS on every passive data connection, bblp/<access code> login,
// PBSZ/PROT P, SIZE, NLST, REST and RETR over an in-memory file map. It counts
// the bytes it actually sends so a test can prove the preview reader fetched
// only a small part of a large .3mf. `noRest` / `noSize` switch those
// commands off to exercise the fallbacks.
const tls = require("tls");

function createFakeFtpsServer({ key, cert, accessCode, files = {}, noRest = false, noSize = false }) {
  const state = { logins: 0, commands: [], bytesSent: 0, retrs: 0, sockets: new Set() };
  const server = tls.createServer({ key, cert }, (sock) => {
    state.sockets.add(sock);
    sock.on("error", () => {});
    sock.on("close", () => state.sockets.delete(sock));
    let buf = "", user = null, authed = false, rest = 0, pasv = null;
    const reply = (line) => sock.write(line + "\r\n");
    reply("220 Bambu FTP ready");
    sock.setEncoding("latin1");
    const openPasv = () => new Promise((resolve) => {
      const conns = [];
      const ds = tls.createServer({ key, cert }, (d) => { d.on("error", () => {}); conns.push(d); if (ds.waiter) ds.waiter(d); });
      ds.listen(0, "127.0.0.1", () => {
        const port = ds.address().port;
        resolve({ ds, port, next: () => conns.length ? Promise.resolve(conns.shift()) : new Promise(r => { ds.waiter = (d) => { ds.waiter = null; conns.shift(); r(d); }; }) });
      });
    });
    const handle = async (line) => {
      const sp = line.indexOf(" ");
      const cmd = (sp === -1 ? line : line.slice(0, sp)).toUpperCase();
      const arg = sp === -1 ? "" : line.slice(sp + 1);
      state.commands.push(cmd === "PASS" ? "PASS ***" : line);
      if (cmd === "USER") { user = arg; return reply("331 Password required"); }
      if (cmd === "PASS") {
        if (user === "bblp" && arg === accessCode) { authed = true; state.logins++; return reply("230 Logged in"); }
        return reply("530 Login incorrect");
      }
      if (cmd === "QUIT") { reply("221 Bye"); return sock.end(); }
      if (!authed) return reply("530 Please login");
      if (cmd === "PBSZ") return reply("200 PBSZ=0");
      if (cmd === "PROT") return reply(arg === "P" ? "200 Protection set to Private" : "536 Only P");
      if (cmd === "TYPE") return reply("200 Type set");
      if (cmd === "SIZE") {
        if (noSize) return reply("502 Command not implemented");
        return files[arg] ? reply("213 " + files[arg].length) : reply("550 No such file");
      }
      if (cmd === "REST") {
        if (noRest) return reply("502 Command not implemented");
        rest = Number(arg) || 0; return reply("350 Restarting at " + rest);
      }
      if (cmd === "PASV") {
        if (pasv) pasv.ds.close();
        pasv = await openPasv();
        return reply(`227 Entering Passive Mode (10,99,99,99,${pasv.port >> 8},${pasv.port & 255})`);
      }
      if (cmd === "RETR" || cmd === "NLST") {
        if (!pasv) return reply("425 Use PASV first");
        let body;
        if (cmd === "RETR") {
          if (!files[arg]) { rest = 0; return reply("550 No such file"); }
          body = files[arg].subarray(rest);
          state.retrs++;
        } else {
          const dir = arg.replace(/\/?$/, "/");
          body = Buffer.from(Object.keys(files).filter(f => f.startsWith(dir) && !f.slice(dir.length).includes("/")).map(f => f.slice(dir.length)).join("\r\n") + "\r\n");
        }
        rest = 0;
        reply("150 Opening BINARY mode data connection");
        const d = await pasv.next();
        const p = pasv; pasv = null;
        let aborted = false;
        d.on("close", () => { aborted = true; });
        for (let o = 0; o < body.length && !aborted; o += 16384) {
          const chunk = body.subarray(o, o + 16384);
          state.bytesSent += chunk.length;
          if (!d.write(chunk)) await new Promise(r => { d.once("drain", r); d.once("close", r); });
        }
        d.end();
        p.ds.close();
        return reply(aborted ? "426 Transfer aborted" : "226 Transfer complete");
      }
      reply("502 Command not implemented");
    };
    let chain = Promise.resolve();
    sock.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        chain = chain.then(() => handle(line)).catch(() => {});
      }
    });
  });
  server.on("tlsClientError", () => {});
  return {
    state, server,
    listen: () => new Promise(r => server.listen(0, "127.0.0.1", () => r(server.address().port))),
    close: () => new Promise(r => { for (const s of state.sockets) s.destroy(); server.close(() => r()); })
  };
}

// A minimal ZIP writer for building test .3mf archives (stored or deflated).
function buildZip(entries) {
  const zlib = require("zlib");
  const locals = [], centrals = [];
  let offset = 0;
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  for (const { name, data, deflate } of entries) {
    const nameBuf = Buffer.from(name);
    const comp = deflate ? zlib.deflateRawSync(data) : data;
    const method = deflate ? 8 : 0, crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

module.exports = { createFakeFtpsServer, buildZip };
