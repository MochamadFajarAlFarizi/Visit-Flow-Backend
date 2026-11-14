import crypto from "node:crypto";

const TOKEN_SECRET =
  process.env.VISITFLOW_AUTH_SECRET || "visit-flow-prototype-secret-key-2026";
const TOKEN_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

function toBase64Url(input) {
  return Buffer.from(input).toString("base64url");
}

function fromBase64Url(input) {
  return Buffer.from(input, "base64url").toString("utf-8");
}

export function isSuperAdmin(user) {
  return user?.role === "SUPER_ADMIN";
}

export function signToken(user) {
  const header = toBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = toBase64Url(
    JSON.stringify({
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      region: user.region,
      exp: Date.now() + TOKEN_TTL_MS,
    })
  );
  const signature = crypto
    .createHmac("sha256", TOKEN_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");

  return `${header}.${payload}.${signature}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== "string") {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [header, payload, signature] = parts;
  const expectedSig = crypto
    .createHmac("sha256", TOKEN_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSig);
  if (
    sigBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expectedBuf)
  ) {
    return null;
  }

  try {
    const decoded = JSON.parse(fromBase64Url(payload));
    if (!decoded.exp || decoded.exp < Date.now()) {
      return null;
    }
    return {
      id: decoded.sub,
      email: decoded.email,
      name: decoded.name,
      role: decoded.role,
      region: decoded.region,
    };
  } catch {
    return null;
  }
}

export function requireAuth(req, res, next) {
  // Reject auth credentials passed via URL query parameters to prevent URL manipulation
  if (req.query.token || req.query.user || req.query.userId) {
    return res.status(401).json({
      error: "Kredensial tidak diperbolehkan pada parameter URL. Gunakan header Authorization.",
    });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Akses ditolak. Silakan login terlebih dahulu.",
    });
  }

  const token = authHeader.slice(7).trim();
  const user = verifyToken(token);
  if (!user) {
    return res.status(401).json({
      error: "Sesi tidak valid atau telah berakhir. Silakan login ulang.",
    });
  }

  req.user = user;
  return next();
}

export function requireSuperAdmin(req, res, next) {
  if (!isSuperAdmin(req.user)) {
    return res.status(403).json({
      error: "Akses ditolak. Fitur ini hanya dapat diakses oleh Super Admin.",
    });
  }
  return next();
}
