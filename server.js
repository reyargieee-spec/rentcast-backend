require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();

/**
 * ✅ CORS (simple + reliable for now)
 * You can lock this down later to your domain once everything works.
 */
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// ✅ IMPORTANT: Express/router no longer likes "*"
app.options(/.*/, cors());

app.use(express.json());

const PORT = process.env.PORT || 3000;

// ✅ Request logger (so you can SEE requests hit Render logs)
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} origin=${req.headers.origin || "none"}`);
  next();
});

app.get("/", (req, res) => {
  res.send("RentCast backend is running");
});

// ✅ Ping route
app.get("/ping", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get("/api/property", async (req, res) => {
  try {
    const address = req.query.address;

    if (!address) {
      return res.status(400).json({ error: "Address is required" });
    }

    const cleanedAddress = String(address).trim();
    console.log("➡️ /api/property address:", cleanedAddress);

    const response = await axios.get("https://api.rentcast.io/v1/properties", {
      headers: { "X-Api-Key": process.env.RENTCAST_API_KEY },
      params: { address: cleanedAddress },
      timeout: 20000
    });

    return res.json(response.data);

  } catch (error) {
    const status = error.response?.status || 500;
    const details = error.response?.data || { message: error.message };

    console.error("❌ RentCast fetch failed:", { status, details });

    return res.status(status).json({
      error: "Failed to fetch property data",
      details
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
