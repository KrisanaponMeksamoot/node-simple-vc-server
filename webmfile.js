/**
 * @param {Uint8Array} buf 
 */
function trimWebm(buf) {
    try {
        let dv = new DataView(buf.buffer, buf.byteOffset);
        let readin = 0;
        function readVarInt() {
            let desc = dv.getUint8(readin++);
            let fb = desc;
            let isz = 8;
            while (fb) {
                isz--;
                fb >>= 1;
            }
            let val = BigInt(desc ^ (0x80 >> isz));
            while (isz--) {
                val <<= 8n;
                val |= BigInt(dv.getUint8(readin++));
            }
            return val;
        }
        { // header
            if (dv.getUint32(readin) != 0x1a45dfa3)
                return null;
            readin += 4;
            readin += parseInt(readVarInt()) + 1;
        }
        { // segment head
            if (dv.getUint32(readin) != 0x18538067)
                return null;
            readin += 4;
            let len = readVarInt();
            if (len != 0xFFFFFFFFFFFFFFn)
                return null;
        }
        while (true) { // other head
            if (dv.getUint32(readin) == 0x1F43B675)
                break;
            readin += 4;
            let len = readVarInt();
            if (len == 0xFFFFFFFFFFFFFFn)
                return null;
            readin += parseInt(len);
        }
        { // clauster head
            if (dv.getUint32(readin) != 0x1F43B675)
                return null;
            readin += 4;
            let len = readVarInt();
            if (len != 0xFFFFFFFFFFFFFFn)
                return null;
        }
        let save_len = readin;

        return trimWebmClauster(buf, save_len);
    } catch (e) {
        // console.warn(e);
        return null;
    }
}

function trimWebmClauster(buf, save_len) {
    let dv = new DataView(buf.buffer, buf.byteOffset);
    let readin = save_len;
    let cont_pos = readin;

    function readVarInt() {
        let desc = dv.getUint8(readin++);
        let fb = desc;
        let isz = 8;
        while (fb) {
            isz--;
            fb >>= 1;
        }
        let val = BigInt(desc ^ (0x80 >> isz));
        while (isz--) {
            val <<= 8n;
            val |= BigInt(dv.getUint8(readin++));
        }
        return val;
    }
    // let n = 0;
    while (readin + 9 < buf.length) {
        let eid = dv.getUint8(readin++);
        if (eid == 0xE7) {
            cont_pos = readin - 1;
        }
        // console.log(eid);
        let len = parseInt(readVarInt());
        if (eid == 0x1a && len == 0x5df) {
            readin -= 3;
            return trimWebm(new Uint8Array(buf.buffer, buf.byteOffset + readin));
        }
        if (readin + len >= buf.length)
            break;
        readin += len;
        // n++;
    }
    if (cont_pos > readin)
        console.log(cont_pos-readin);
    // console.log(`n: ${n}`);
    let buffer = new Uint8Array(save_len + buf.length - cont_pos);
    buffer.set(new Uint8Array(buf.buffer, buf.byteOffset, save_len), 0);
    buffer.set(new Uint8Array(buf.buffer, buf.byteOffset + cont_pos, buf.length - cont_pos), save_len);

    return { buffer, save_len };
}

module.exports = { trimWebm, trimWebmClauster };