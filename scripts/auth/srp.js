// Cognito SRP. Comp/Con's app client disables USER_PASSWORD_AUTH.

const N_HEX =
    "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74"
  + "020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437"
  + "4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED"
  + "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF05"
  + "98DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB"
  + "9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B"
  + "E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF695581718"
  + "3995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33"
  + "A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7"
  + "ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864"
  + "D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E2"
  + "08E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF";

const N = BigInt("0x" + N_HEX);
const g = 2n;
const INFO_BITS = new TextEncoder().encode("Caldera Derived Key");

function hexToBytes(hex) {
    if (hex.length % 2)
        hex = "0" + hex;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++)
        out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
}
function bytesToHex(bytes) {
    return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}
function bigIntToHex(bi) {
    return bi.toString(16);
}
function bytesToBigInt(bytes) {
    const hex = bytesToHex(bytes);
    return BigInt("0x" + (hex || "0"));
}

// Even-length hex, "00"-prefixed when MSB is 8-F (Cognito's exact rule).
function padHex(input) {
    let hex = (typeof input === "bigint") ? bigIntToHex(input) : String(input);
    if (hex.length % 2 === 1) {
        hex = "0" + hex;
    } else if ("89abcdef".indexOf(hex[0].toLowerCase()) !== -1) {
        hex = "00" + hex;
    }
    return hex;
}

async function sha256(bytes) {
    const buf = await crypto.subtle.digest("SHA-256", bytes);
    return new Uint8Array(buf);
}
async function sha256Hex(hex) {
    return sha256(hexToBytes(hex));
}
async function hmacSha256(keyBytes, dataBytes) {
    const key = await crypto.subtle.importKey(
        "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, dataBytes);
    return new Uint8Array(sig);
}
async function hkdf16(ikm, salt) {
    const prk = await hmacSha256(salt, ikm);
    const infoBlock = new Uint8Array(INFO_BITS.length + 1);
    infoBlock.set(INFO_BITS, 0);
    infoBlock[INFO_BITS.length] = 0x01;
    const t = await hmacSha256(prk, infoBlock);
    return t.slice(0, 16);
}

function modPow(base, exp, mod) {
    let result = 1n;
    base = ((base % mod) + mod) % mod;
    while (exp > 0n) {
        if (exp & 1n) result = (result * base) % mod;
        exp >>= 1n;
        base = (base * base) % mod;
    }
    return result;
}

function randomBigInt(bits) {
    const bytes = new Uint8Array(bits / 8);
    crypto.getRandomValues(bytes);
    return bytesToBigInt(bytes);
}

function concatBytes(...arrs) {
    let len = 0;
    for (const a of arrs) len += a.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const a of arrs) { out.set(a, off); off += a.length; }
    return out;
}

// "Day Mon D HH:MM:SS UTC YYYY" - day NOT zero-padded, time IS. AWS checks verbatim.
function cognitoTimestamp() {
    const d = new Date();
    const wk = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getUTCDay()];
    const mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()];
    const day = d.getUTCDate();
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    const ss = String(d.getUTCSeconds()).padStart(2, "0");
    return `${wk} ${mo} ${day} ${hh}:${mm}:${ss} UTC ${d.getUTCFullYear()}`;
}

export function generateSrpA() {
    let a;
    let A;
    do {
        a = randomBigInt(256);
        A = modPow(g, a, N);
    } while (A % N === 0n);
    return { a, A };
}

export async function computePasswordSignature({
    a, A, srpBHex, saltHex,
    poolId, userIdForSrp, password, secretBlockB64
}) {
    const B = BigInt("0x" + srpBHex);
    if (B % N === 0n)
        throw new Error("Invalid SRP B from server");

    const k = BigInt("0x" + bytesToHex(await sha256Hex(padHex(N) + padHex(g))));
    const u = BigInt("0x" + bytesToHex(await sha256Hex(padHex(A) + padHex(B))));
    if (u === 0n)
        throw new Error("SRP u cannot be zero");

    const poolName = poolId.split("_")[1];
    if (!poolName)
        throw new Error(`Bad pool id: ${poolId}`);

    const innerInput = new TextEncoder().encode(`${poolName}${userIdForSrp}:${password}`);
    const innerHashHex = bytesToHex(await sha256(innerInput));
    const x = BigInt("0x" + bytesToHex(await sha256Hex(padHex(saltHex) + innerHashHex)));

    const gx = modPow(g, x, N);
    let base = (B - (k * gx)) % N;
    if (base < 0n)
        base += N;
    const S = modPow(base, a + (u * x), N);

    const hkdfKey = await hkdf16(hexToBytes(padHex(S)), hexToBytes(padHex(u)));

    const timestamp = cognitoTimestamp();
    const secretBlockBytes = Uint8Array.from(atob(secretBlockB64), c => c.charCodeAt(0));
    const sigInput = concatBytes(
        new TextEncoder().encode(poolName),
        new TextEncoder().encode(userIdForSrp),
        secretBlockBytes,
        new TextEncoder().encode(timestamp)
    );
    const sig = await hmacSha256(hkdfKey, sigInput);
    const signatureB64 = btoa(String.fromCharCode(...sig));

    return { signatureB64, timestamp };
}

export const SRP_DEBUG = { N_HEX, padHex, hkdf16, cognitoTimestamp };
