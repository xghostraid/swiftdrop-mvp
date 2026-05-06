const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "swiftdrop-local-secret";

function decodeToken(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function optionalAuth(req, _res, next) {
  req.user = decodeToken(req);
  next();
}

function requireAuth(req, res, next) {
  req.user = decodeToken(req);
  if (!req.user) return res.status(401).json({ error: "Authentication required." });
  return next();
}

module.exports = {
  JWT_SECRET,
  optionalAuth,
  requireAuth
};
