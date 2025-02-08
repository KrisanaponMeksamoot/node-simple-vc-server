var socket = new WebSocket(`wss://${location.host}/ws`);

const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const inp_autoconnect = document.getElementById('autoconnect');

const AUDIO_FORMAT = "audio/webm;codecs=opus";

const tea_log = document.getElementById("log");
function log(...param) {
    console.log(...param);
    tea_log.innerText += param.map(e => e.toString()).join(" ") + "\n";
}

const div_status = document.getElementById("status");

{
    let query = new URLSearchParams(location.search);
    if (query.has("autoconnect"))
        inp_autoconnect.checked = Boolean(query.get("autoconnect"))
}

let mediaRecorder;
let audioStream;

socket.onopen = () => {
    console.log('WebSocket connection established');
};

socket.onerror = (error) => {
    console.error('WebSocket error: ', error);
};

startButton.onclick = async () => {
    log("loading");
    let mp = await navigator.permissions.query({ name: 'microphone' });
    if (mp.state == "denied") {
        log("no microphone permission");
    }
    let stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    startStream(stream);
};

function startStream(stream) {
    audioStream = stream;

    mediaRecorder = new MediaRecorder(stream, { mimeType: AUDIO_FORMAT, audioBitsPerSecond: 96000 });

    startButton.disabled = true;
    stopButton.disabled = false;

    mediaRecorder.start(100);

    mediaRecorder.onstart = () => {
        socket.send(packpack("refresh-buffer", ZERO_ARRAY));
        log("streaming");
    }
    mediaRecorder.ondataavailable = async (event) => {
        socket.send(packpack("audiodata", new Uint8Array(await event.data.arrayBuffer())));
    };

    mediaRecorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop());
    };
}

stopButton.onclick = () => {
    mediaRecorder.stop();
    startButton.disabled = false;
    stopButton.disabled = true;
    // socket.send(packpack("refresh-buffer", ZERO_ARRAY));
};

async function refreshStream() {
    if (mediaRecorder) {
        // let stream = mediaRecorder.stream;
        mediaRecorder.stop();
        startStream(await navigator.mediaDevices.getUserMedia({ audio: true }));
    }
}

socket.onclose = () => {
    console.log('WebSocket connection closed');
    log("server closed");
};

const tbody_clist = document.querySelector("table.clientlist>tbody");

const medias = new Map();
const client_list = new Map();

var uuid, ip;
socket.addEventListener("message", async (ev) => {
    let msg;
    if (ev.data instanceof Blob)
        msg = new Uint8Array(await ev.data.arrayBuffer());
    else
        msg = new Uint8Array(ev.data);
    let id_len = msg[0];
    let id = String.fromCharCode(...msg.slice(1, id_len + 1));
    let argv = new Uint8Array(msg.buffer, id_len + 1);
    switch (id) {
        case "setinfo": {
            let json = JSON.parse(String.fromCharCode(...argv));
            uuid = json.uuid;
            ip = json.ip;
            console.log(`IP: ${ip}, UUID: ${uuid}`);
            div_status.innerText = `IP: ${ip}, UUID: ${uuid}`;
        } break;
        case "lsclient": {
            let lsclient = JSON.parse(String.fromCharCode(...argv));
            let clis = [];
            for (let { uuid: tuuid, ip } of lsclient) {
                if (tuuid == uuid)
                    continue;
                clis.push(tuuid);
                if (client_list.has(tuuid))
                    continue;
                let tr = document.createElement("tr");

                let td_uuid = document.createElement("td");
                td_uuid.appendChild(document.createTextNode(tuuid));
                tr.appendChild(td_uuid);

                let td_ip = document.createElement("td");
                td_ip.appendChild(document.createTextNode(ip));
                tr.appendChild(td_ip);

                let td_con = document.createElement("td");
                let btn_sub = document.createElement("input");
                btn_sub.type = "button";
                btn_sub.value = "enable";
                td_con.appendChild(btn_sub);
                tr.appendChild(td_con);

                let td_aud = document.createElement("td");
                tr.appendChild(td_aud);
                tbody_clist.appendChild(tr);
                let tcli = { tr, td_uuid, td_aud };
                client_list.set(tuuid, tcli);
                btn_sub.addEventListener("click", () => {
                    if (tcli.med) {
                        unsubscribeClient(tuuid);
                        btn_sub.value = "enable";
                    } else {
                        subscribeClient(tuuid);
                        btn_sub.value = "disable";
                    }
                });
                if (inp_autoconnect.checked) {
                    subscribeClient(tuuid);
                    btn_sub.value = "disable";
                }
            }
            for (let [tuuid, tcli] of client_list) {
                if (!clis.includes(tuuid)) {
                    tcli.tr.remove();
                    if (tcli.med)
                        tcli.med.close();
                }
            }
        } break;
        case "refresh-buffer":
            if (argv.length == 0) {
                refreshStream();
                break;
            }
            let tuuid = String.fromCharCode(...argv);
            if (medias.has(tuuid)) {
                medias.get(tuuid).refreshBuffer();
            }
            break;
        case "err":
            console.warn(`Server: ${String.fromCharCode(...argv)}`);
            break;
        default:
            if (id.startsWith("audiodata")) {
                let srcid = id.slice(9);
                if (medias.has(srcid)) {
                    let { appendBuffer } = medias.get(srcid);
                    appendBuffer(argv);
                } else
                    socket.send(packpack("err", getBytes(`excess audio data: ${srcid}`)));
            } else
                socket.send(packpack("err", getBytes(`Unknown id: ${id}`)));
    }
});

function createAudioNode(uuid) {
    let aud = new Audio();
    let msrc = new MediaSource();
    let queue = [];
    let bufhasdata = false;

    let med = {
        aud,
        bs: null,
        close() {
            console.log(`close ${uuid}`);
            aud.remove();
            if (msrc.readyState === "open") {
                try {
                    msrc.endOfStream();
                } catch (e) {
                    console.warn("Cannot end stream:", e);
                }
            }
        },
        appendBuffer(buf) {
            queue.push(buf);
            processQueue();
        },
        refreshBuffer() {
            queue = [];
            if (!bufhasdata)
                return;
            try {
                bufhasdata = false;
                this.bs.abort();
                this.bs.remove(0, this.aud.duration);
                // msrc.removeSourceBuffer(this.bs);
                this.aud.currentTime = 0;
                // this.bs = msrc.addSourceBuffer(AUDIO_FORMAT);
                // this.bs.addEventListener("updateend", processQueue);
                // processQueue();
            } catch (e) {
                console.error("Failed to refresh SourceBuffer:", e);
            }
        }
    };

    function processQueue() {
        if (med.bs && !med.bs.updating && queue.length > 0) {
            let nbuf = new Uint8Array(queue.reduce((s, b) => b.length + s, 0));
            let offset = 0;
            queue.forEach(fragment => {
                nbuf.set(fragment, offset);
                offset += fragment.length;
            });
            queue = [];
            try {
                med.bs.appendBuffer(nbuf);
                bufhasdata = true;
            } catch (e) {
                console.error("appendBuffer failed:", e);
            }
        }
    }

    function setupMsrc() {
        msrc.onsourceopen = () => {
            try {
                med.bs = msrc.addSourceBuffer(AUDIO_FORMAT);
                med.bs.addEventListener("updateend", processQueue);
                processQueue();
            } catch (e) {
                console.error("Failed to add SourceBuffer:", e);
            }
        };
    }
    setupMsrc();

    medias.set(uuid, med);
    client_list.get(uuid).med = med;

    aud.src = URL.createObjectURL(msrc);
    aud.autoplay = true;
    aud.controls = true;
    // aud.play();
    client_list.get(uuid).td_aud.appendChild(aud);
}

function subscribeClient(uuid) {
    createAudioNode(uuid);

    socket.send(packpack("subscribe", getBytes(uuid)));
}


function unsubscribeClient(uuid = "") {
    if (uuid == "") {
        [...medias.values()].forEach(obj => obj.close());
        medias.clear();
        [...client_list.values()].forEach(obj => obj.med = undefined);
        console.log("unsubscribe all");
    } else {
        medias.get(uuid).close();
        client_list.get(uuid).med = undefined;
        medias.delete(uuid);
    }
    socket.send(packpack("unsubscribe", getBytes(uuid)));
}

function refreshClients() {
    socket.send(packpack("lsclient", ZERO_ARRAY));
}

const ZERO_ARRAY = new Uint8Array(0);

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