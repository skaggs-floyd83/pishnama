// server.js (Express 5 safe)
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const pub = path.join(__dirname, "public");
app.use(express.static(pub, { maxAge: "1h" }));

// Catch-all for SPA *without any path pattern*
app.use((req, res) => {
  res.sendFile(path.join(pub, "sofa.html"));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Pishnama demo running at http://localhost:${PORT}`);
});
