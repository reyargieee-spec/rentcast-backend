require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();

/**
 * ✅ CORS (important)
 * - Allows your website domain + local dev
 * - Handles preflight OPTIONS requests
 *
 * If you want to allow ANY domain temporarily, switch origin to "*"
 */
const allowedOrigins = [
  "https://legacybuilderempire.com",
  "https://www.legacybuilderempire.com",
  "http://localhost:3000",
  "http://127.0.0.1:5500"
];

app.use(cors({
  origin: function (origin, callback) {
    // allow requests with no origin (like Postman/curl)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Not allowed by CORS: " + origin));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204
}));

// ✅ Preflight handler (helps when browser sends OPTIONS)
app.options("*", cors());

app.use(express.json());

const PORT = process.env.PORT || 3000;

/**
 * ✅ Simple request logger (so you SEE requests hitting Render)
 */
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} origin=${req.headers.origin || "none"}`);
  next();
});

/**
 * ✅ Health check / Ping (use this to confirm frontend -> backend works)
 * Visit: https://rentcast-backend.onrender.com/ping
 */
app.get("/ping", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get("/", (req, res) => {
  res.send("RentCast backend is running");
});

app.get("/api/property", async (req, res) => {
  try {
    const address = req.query.address;

    if (!address) {
      return res.status(400).json({ error: "Address is required" });
    }

    // ✅ Optional: Trim/normalize
    const cleanedAddress = String(address).trim();

    console.log("➡️  /api/property address:", cleanedAddress);

    const response = await axios.get("https://api.rentcast.io/v1/properties", {
      headers: { "X-Api-Key": process.env.RENTCAST_API_KEY },
      params: { address: cleanedAddress },
      timeout: 20000
    });

    return res.json(response.data);
  } catch (error) {
    const status = error.response?.status || 500;
    const details = error.response?.data || { message: error.message };

    // ✅ Make sure it prints in Render logs
    console.error("❌ RentCast fetch failed:", {
      status,
      details,
      message: error.message
    });

    return res.status(status).json({
      error: "Failed to fetch property data",
      details
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
