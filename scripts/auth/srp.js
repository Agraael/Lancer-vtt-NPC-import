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

const SRP_PRIME = BigInt("0x" + N_HEX);
const SRP_GENERATOR = 2n;
const INFO_BITS = new TextEncoder().encode("Caldera Derived Key");

function hexToBytes(hex)
{
    if (hex.length % 2)
        hex = "0" + hex;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++)
        out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
}
function bytesToHex(bytes)
{
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
function bigIntToHex(value)
{
    return value.toString(16);
}
function bytesToBigInt(bytes)
{
    const hex = bytesToHex(bytes);
    return BigInt("0x" + (hex || "0"));
}

// Even-length hex, "00"-prefixed when MSB is 8-F (Cognito's exact rule).
function padHex(input)
{
    let hex = (typeof input === "bigint") ? bigIntToHex(input) : String(input);
    if (hex.length % 2 === 1)
    {
        hex = "0" + hex;
    }
    else if ("89abcdef".indexOf(hex[0].toLowerCase()) !== -1)
    {
        hex = "00" + hex;
    }
    return hex;
}

async function sha256(bytes)
{
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return new Uint8Array(digest);
}
async function sha256Hex(hex)
{
    return sha256(hexToBytes(hex));
}
async function hmacSha256(keyBytes, dataBytes)
{
    const key = await crypto.subtle.importKey(
        "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, dataBytes);
    return new Uint8Array(signature);
}
async function hkdf16(ikm, salt)
{
    const prk = await hmacSha256(salt, ikm);
    const infoBlock = new Uint8Array(INFO_BITS.length + 1);
    infoBlock.set(INFO_BITS, 0);
    infoBlock[INFO_BITS.length] = 0x01;
    const block = await hmacSha256(prk, infoBlock);
    return block.slice(0, 16);
}

function modPow(base, exp, mod)
{
    let result = 1n;
    base = ((base % mod) + mod) % mod;
    while (exp > 0n)
    {
        if (exp & 1n)
            result = (result * base) % mod;
        exp >>= 1n;
        base = (base * base) % mod;
    }
    return result;
}

function randomBigInt(bits)
{
    const bytes = new Uint8Array(bits / 8);
    crypto.getRandomValues(bytes);
    return bytesToBigInt(bytes);
}

function concatBytes(...parts)
{
    let length = 0;
    for (const part of parts)
        length += part.length;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
}

// "Day Mon D HH:MM:SS UTC YYYY" - day NOT zero-padded, time IS. AWS checks verbatim.
function cognitoTimestamp()
{
    const now = new Date();
    const weekday = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][now.getUTCDay()];
    const month = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][now.getUTCMonth()];
    const day = now.getUTCDate();
    const hours = String(now.getUTCHours()).padStart(2, "0");
    const minutes = String(now.getUTCMinutes()).padStart(2, "0");
    const seconds = String(now.getUTCSeconds()).padStart(2, "0");
    return `${weekday} ${month} ${day} ${hours}:${minutes}:${seconds} UTC ${now.getUTCFullYear()}`;
}

export function generateSrpA()
{
    let privateKey;
    let publicKey;
    do
    {
        privateKey = randomBigInt(256);
        publicKey = modPow(SRP_GENERATOR, privateKey, SRP_PRIME);
    } while (publicKey % SRP_PRIME === 0n);
    return { privateKey, publicKey };
}

export async function computePasswordSignature({
    privateKey, publicKey, srpBHex, saltHex,
    poolId, userIdForSrp, password, secretBlockB64
})
{
    const serverPublic = BigInt("0x" + srpBHex);
    if (serverPublic % SRP_PRIME === 0n)
        throw new Error("Invalid SRP B from server");

    const multiplier = BigInt("0x" + bytesToHex(await sha256Hex(padHex(SRP_PRIME) + padHex(SRP_GENERATOR))));
    const scrambler = BigInt("0x" + bytesToHex(await sha256Hex(padHex(publicKey) + padHex(serverPublic))));
    if (scrambler === 0n)
        throw new Error("SRP u cannot be zero");

    const poolName = poolId.split("_")[1];
    if (!poolName)
        throw new Error(`Bad pool id: ${poolId}`);

    const innerInput = new TextEncoder().encode(`${poolName}${userIdForSrp}:${password}`);
    const innerHashHex = bytesToHex(await sha256(innerInput));
    const passwordHash = BigInt("0x" + bytesToHex(await sha256Hex(padHex(saltHex) + innerHashHex)));

    const verifier = modPow(SRP_GENERATOR, passwordHash, SRP_PRIME);
    let base = (serverPublic - (multiplier * verifier)) % SRP_PRIME;
    if (base < 0n)
        base += SRP_PRIME;
    const sharedSecret = modPow(base, privateKey + (scrambler * passwordHash), SRP_PRIME);

    const hkdfKey = await hkdf16(hexToBytes(padHex(sharedSecret)), hexToBytes(padHex(scrambler)));

    const timestamp = cognitoTimestamp();
    const secretBlockBytes = Uint8Array.from(atob(secretBlockB64), char => char.charCodeAt(0));
    const sigInput = concatBytes(
        new TextEncoder().encode(poolName),
        new TextEncoder().encode(userIdForSrp),
        secretBlockBytes,
        new TextEncoder().encode(timestamp)
    );
    const signature = await hmacSha256(hkdfKey, sigInput);
    const signatureB64 = btoa(String.fromCharCode(...signature));

    return { signatureB64, timestamp };
}

export const SRP_DEBUG = { N_HEX, padHex, hkdf16, cognitoTimestamp };
