# Test-only TLS fixtures for the Bambu Lab connector

`ca.pem` is a throwaway CA generated for SnapCon's test suite, and each
`<CN>.pem` / `<CN>-key.pem` pair is a server certificate it signed whose common
name is a made-up printer serial — the same shape a real Bambu Lab printer
presents (CN = serial, no subjectAltName). The CA's private key was discarded
after signing. None of this is trusted anywhere outside
`test/connectors/bambulab-h2-tls.test.js`, which adds `ca.pem` to the trust
list only for the duration of that test.

Regenerate (100-year validity) with:

    openssl req -x509 -newkey rsa:2048 -nodes -keyout ca-key.pem -out ca.pem -days 36500 \
      -subj "/C=XX/O=SnapCon Test Only/CN=SnapCon Test Bambu CA" \
      -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
    for cn in TESTSERIAL0001 SOMEOTHERSERIAL; do
      openssl req -newkey rsa:2048 -nodes -keyout $cn-key.pem -out $cn.csr -subj "/CN=$cn"
      openssl x509 -req -in $cn.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -out $cn.pem -days 36500
      rm $cn.csr
    done
    rm ca-key.pem ca.srl
