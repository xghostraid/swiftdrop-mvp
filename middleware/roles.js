function requireRole(...roles) {
  const allowed = new Set(roles);
  return (req, res, next) => {
    const role = req.user?.role;
    if (!role || !allowed.has(role)) {
      return res.status(403).json({ error: "Insufficient role permissions." });
    }
    return next();
  };
}

module.exports = { requireRole };
