const express = require('express');
const https = require("https");
const WebSocket = require('ws');
const path = require('path');
const fs = require("fs");
const { v4 } = require("uuid");
const EventEmitter = require('events');
const { trimWebm, trimWebmClauster } = require('./webmfile');

const PORT = 443;

const app = express();
const http_options = {
    key: fs.readFileSync('key.pem'),
    cert: fs.readFileSync('cert.pem')
};
const server = https.createServer(http_options, app);

app.use(express.static(path.join(__dirname, 'public')));

const wss = new WebSocket.Server({ server, path: "/ws" });

const ZERO_ARRAY = new Uint8Array(0);

const clients = new Map();

wss.on('connection', (socket, req) => {
    const uuid = v4();
    clients.set(uuid, socket);
    console.log(`connect ${uuid} ${req.socket.remoteAddress.toString()}`);
    socket.remoteAddress = req.socket.remoteAddress;
    socket.send(packpack("setinfo", getBytes(JSON.stringify({ uuid, ip: socket.remoteAddress.toString() }))));
    socket.audchan = new EventEmitter();
    let srcList = new Map();

    socket.audchan.audiobuffers = []
    socket.audchan.save_len = null;

    socket.on('message', (data, isBinary) => {
        let msg = new Uint8Array(data);
        let id_len = msg[0];
        let id = String.fromCharCode(...msg.slice(1, id_len + 1));
        let argv = new Uint8Array(msg.buffer, id_len + 1);
        switch (id) {
            case "lsclient":
                socket.lsclient()
                break;
            case "audiodata": {
                socket.audchan.audiobuffers.push(argv);
                socket.audchan.emit("audiodata", argv);
                if (!socket.audchan.save_len) {
                    let nbuf = Buffer.concat(socket.audchan.audiobuffers);
                    let res = trimWebm(nbuf);
                    if (res) {
                        let { buffer, save_len } = res;
                        socket.audchan.save_len = save_len;
                        nbuf = buffer;
                    }
                    socket.audchan.audiobuffers = [nbuf];
                }
            } break;
            case "refresh-buffer": {
                socket.audchan.audiobuffers = []
                socket.audchan.emit("refresh-buffer");
                socket.audchan.save_len = null;
            } break;
            case "subscribe": {
                let tuuid = String.fromCharCode(...argv);
                if (!clients.has(tuuid)) {
                    socket.send(packpack("err", getBytes(`Unknown uuid: ${tuuid.toString()}`)));
                    break;
                }
                let sendBuffer = (data) => {
                    socket.send(packpack(`audiodata${tuuid.toString()}`, data));
                };
                let refreshBuffer = () => {
                    socket.send(packpack(`refresh-buffer`, argv));
                };
                srcList.set(tuuid, { sendBuffer, refreshBuffer });
                let chan = clients.get(tuuid).audchan;
                chan.on("audiodata", sendBuffer);
                chan.on("refresh-buffer", refreshBuffer);
                let nbuf = Buffer.concat(chan.audiobuffers);
                let res = chan.save_len ? trimWebmClauster(nbuf, chan.save_len) : trimWebm(nbuf);
                if (res) {
                    let { buffer, save_len } = res;
                    chan.save_len = save_len;
                    nbuf = buffer;
                }
                chan.audiobuffers = [nbuf];
                sendBuffer(nbuf);
                clients.get(tuuid).send(packpack("refresh-buffer", ZERO_ARRAY));
                console.log(`client ${uuid.toString()} subscribe ${tuuid.toString()}`);
            } break;
            case "unsubscribe": {
                if (argv.length == 0) {
                    for (let [s, { sendBuffer, refreshBuffer }] of srcList) {
                        if (clients.has(s)) {
                            let audchan = clients.get(s).audchan;
                            audchan.off("audiodata", sendBuffer);
                            audchan.off("refresh-buffer", refreshBuffer);
                        }
                    }
                    srcList.clear();
                    console.log(`client ${uuid.toString()} unsubscribe all`);
                } else {
                    tuuid = String.fromCharCode(...argv);
                    if (clients.has(tuuid)) {
                        let audchan = clients.get(tuuid).audchan;
                        let { sendBuffer, refreshBuffer } = srcList.get(tuuid)
                        audchan.off("audiodata", sendBuffer);
                        audchan.off("refresh-buffer", refreshBuffer);
                    }
                    srcList.delete(tuuid);
                    console.log(`client ${uuid.toString()} unsubscribe ${tuuid.toString()}`);
                }
            } break;
            case "err":
                console.warn(`Client ${uuid}: ${String.fromCharCode(...argv)}`);
                break;
            default:
                socket.send(packpack("err", getBytes(`Unknown id: ${id}`)));
        }
    });

    socket.lsclient = () => {
        let ls = [];
        for (let [k, v] of clients.entries()) {
            ls.push({ uuid: k.toString(), ip: v.remoteAddress.toString() });
        }
        socket.send(packpack("lsclient", getBytes(JSON.stringify(ls))));
    };

    socket.on('close', (code, reason) => {
        console.log(`disconnect ${uuid}`);
        clients.delete(uuid);
        wss.clients.forEach(s => s.lsclient());
    });
    wss.clients.forEach(s => s.lsclient());
});

/**
 * @param {string} id 
 * @param {Uint8Array} argv 
 */
function packpack(id, argv) {
    let buf = new Uint8Array(id.length + 1 + argv.length);
    buf[0] = id.length;
    buf.set(argv, id.length + 1);
    buf.set(getBytes(id), 1);
    return buf;
}

function getBytes(str) {
    return getBytes.TEXT_ENC.encode(str);
}
getBytes.TEXT_ENC = new TextEncoder();

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});