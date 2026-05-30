// Cognito REST client; replaces the Amplify Auth dropped in Lancer v2.12.0.

import { corsProxyFetch } from "../v3-api.js";
import { generateSrpA, computePasswordSignature } from "./srp.js";

const COGNITO_REGION    = "us-east-1";
const COGNITO_POOL_ID   = "us-east-1_AdX2iSx8s";
const COGNITO_CLIENT_ID = "5v4pvpbr6mbcgfj0cll14trpkk";
const COGNITO_IDP_URL   = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`;

const SETTING_EMAIL         = "compconEmail";
const SETTING_ID_TOKEN      = "compconIdToken";
const SETTING_REFRESH_TOKEN = "compconRefreshToken";
const SETTING_EXPIRY        = "compconTokenExpiry";
const SETTING_SUB           = "compconUserSub";

const REFRESH_GRACE_MS = 60_000;

function _getSetting(key)
{
    try { return game.settings.get("lancer-npc-import", key); }
    catch { return ""; }
}
async function _setSetting(key, value)
{
    try { await game.settings.set("lancer-npc-import", key, value); }
    catch (e) { console.warn(`[cognito-auth] could not store ${key}:`, e); }
}

function _decodeJwtPayload(jwt)
{
    try
    {
        const part = jwt.split(".")[1];
        const padded = part.replace(/-/g, "+").replace(/_/g, "/")
            + "===".slice((part.length + 3) % 4);
        return JSON.parse(atob(padded));
    }
    catch
    {
        return null;
    }
}

async function _cognitoCall(target, payload)
{
    const init = {
        method: "POST",
        headers: {
            "Content-Type": "application/x-amz-json-1.1",
            "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}`
        },
        body: JSON.stringify(payload)
    };

    let resp;
    try
    {
        resp = await fetch(COGNITO_IDP_URL, init);
    }
    catch
    {
        resp = await corsProxyFetch(COGNITO_IDP_URL, init, { json: true });
    }

    const text = await resp.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; }
    catch { /* leave null */ }

    if (!resp.ok)
    {
        const code = body?.__type || `HTTP ${resp.status}`;
        const msg = body?.message || resp.statusText || "Unknown error";
        console.warn(`[cognito-auth] ${target} failed:`, { status: resp.status, body, rawText: text });
        const err = new Error(`${code}: ${msg}`);
        err.cognitoType = body?.__type || null;
        err.status = resp.status;
        throw err;
    }
    return body;
}

async function _storeAuthResult(authResult, emailIfSet)
{
    if (!authResult)
        return;
    const idToken = authResult.IdToken;
    const refreshToken = authResult.RefreshToken;
    const expiresIn = authResult.ExpiresIn || 3600;
    const expiry = Date.now() + (expiresIn * 1000);

    const payload = idToken ? _decodeJwtPayload(idToken) : null;
    const sub = payload?.sub || "";

    if (idToken)
        await _setSetting(SETTING_ID_TOKEN, idToken);
    if (refreshToken)
        await _setSetting(SETTING_REFRESH_TOKEN, refreshToken);
    await _setSetting(SETTING_EXPIRY, expiry);
    if (sub)
        await _setSetting(SETTING_SUB, sub);
    if (emailIfSet)
        await _setSetting(SETTING_EMAIL, emailIfSet);
}

export async function login(email, password)
{
    const { a, A } = generateSrpA();

    const initBody = await _cognitoCall("InitiateAuth", {
        AuthFlow: "USER_SRP_AUTH",
        ClientId: COGNITO_CLIENT_ID,
        AuthParameters: {
            USERNAME: email,
            SRP_A: A.toString(16)
        }
    });

    if (initBody?.ChallengeName !== "PASSWORD_VERIFIER")
        throw new Error(`Unexpected Cognito challenge "${initBody?.ChallengeName || "(none)"}".`);

    const cp = initBody.ChallengeParameters || {};
    const { signatureB64, timestamp } = await computePasswordSignature({
        a,
        A,
        srpBHex: cp.SRP_B,
        saltHex: cp.SALT,
        poolId: COGNITO_POOL_ID,
        userIdForSrp: cp.USER_ID_FOR_SRP,
        password,
        secretBlockB64: cp.SECRET_BLOCK
    });

    const verifyBody = await _cognitoCall("RespondToAuthChallenge", {
        ClientId: COGNITO_CLIENT_ID,
        ChallengeName: "PASSWORD_VERIFIER",
        ChallengeResponses: {
            USERNAME: cp.USERNAME,
            PASSWORD_CLAIM_SECRET_BLOCK: cp.SECRET_BLOCK,
            PASSWORD_CLAIM_SIGNATURE: signatureB64,
            TIMESTAMP: timestamp
        }
    });

    if (verifyBody?.ChallengeName)
    {
        throw new Error(`Additional Cognito challenge "${verifyBody.ChallengeName}" not supported. Sign in at compcon.app to clear it.`);
    }
    await _storeAuthResult(verifyBody?.AuthenticationResult, email);
    return true;
}

export async function refresh()
{
    const refreshToken = _getSetting(SETTING_REFRESH_TOKEN);
    if (!refreshToken)
        throw new Error("No refresh token stored. Sign in again.");
    const body = await _cognitoCall("InitiateAuth", {
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: COGNITO_CLIENT_ID,
        AuthParameters: { REFRESH_TOKEN: refreshToken }
    });
    const ar = body?.AuthenticationResult || {};
    if (!ar.RefreshToken)
        ar.RefreshToken = refreshToken; // REFRESH_TOKEN_AUTH never returns one

    await _storeAuthResult(ar, null);
    return true;
}

export async function getValidJwt()
{
    const stored = _getSetting(SETTING_ID_TOKEN);
    const expiry = Number(_getSetting(SETTING_EXPIRY) || 0);
    if (stored && expiry > Date.now() + REFRESH_GRACE_MS)
        return stored;
    if (!_getSetting(SETTING_REFRESH_TOKEN))
        return null;
    try
    {
        await refresh();
        return _getSetting(SETTING_ID_TOKEN) || null;
    }
    catch (e)
    {
        console.warn("[cognito-auth] refresh failed:", e.message);
        return null;
    }
}

export function getUserSub()
{
    const stored = _getSetting(SETTING_SUB);
    if (stored)
        return stored;
    const jwt = _getSetting(SETTING_ID_TOKEN);
    return jwt ? (_decodeJwtPayload(jwt)?.sub || null) : null;
}

export function getEmail()
{
    return _getSetting(SETTING_EMAIL) || "";
}

export function isLoggedIn()
{
    return !!_getSetting(SETTING_REFRESH_TOKEN);
}

export async function logout()
{
    const accessToken = _getSetting(SETTING_ID_TOKEN);
    if (accessToken)
    {
        try
        {
            await _cognitoCall("GlobalSignOut", { AccessToken: accessToken });
        }
        catch (e)
        {
            console.warn("[cognito-auth] GlobalSignOut failed:", e.message);
        }
    }
    await _setSetting(SETTING_EMAIL, "");
    await _setSetting(SETTING_ID_TOKEN, "");
    await _setSetting(SETTING_REFRESH_TOKEN, "");
    await _setSetting(SETTING_EXPIRY, 0);
    await _setSetting(SETTING_SUB, "");
}

export const COGNITO_SETTINGS_KEYS = {
    email: SETTING_EMAIL,
    idToken: SETTING_ID_TOKEN,
    refreshToken: SETTING_REFRESH_TOKEN,
    expiry: SETTING_EXPIRY,
    sub: SETTING_SUB
};
