require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

// Safe OPTIONS handler (avoids Express 5 wildcard issues)
app.options(/.*/, cors());

const PORT = process.env.PORT || 3000;
const RENTCAST_BASE = "https://api.rentcast.io/v1";

function getAddress(req, res) {
  const address = (req.query.address || "").trim();
  if (!address) {
    res.status(400).json({ ok: false, error: "address is required" });
    return null;
  }
  return address;
}

app.get("/", (req, res) => {
  res.send("RentCast backend is running");
});

app.get("/ping", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ✅ exact property lookup (public records)
app.get("/api/property", async (req, res) => {
  const address = getAddress(req, res);
  if (!address) return;

  try {
    const r = await axios.get(`${RENTCAST_BASE}/properties`, {
      headers: { "X-Api-Key": process.env.RENTCAST_API_KEY },
      params: { address, limit: 5 },
      timeout: 20000
    });

    res.json({ ok: true, type: "property", data: r.data });
  } catch (err) {
    res.status(err.response?.status || 500).json({
      ok: false,
      type: "property",
      error: "Failed to fetch property data",
      details: err.response?.data || { message: err.message }
    });
  }
});

// ✅ nearby rental comps (Comparable Listings)
app.get("/api/nearby-rentals", async (req, res) => {
  const address = getAddress(req, res);
  if (!address) return;

  const radius = Number(req.query.radius ?? 0.5);
  const limit = Math.min(Number(req.query.limit ?? 10), 25);

  try {
    const r = await axios.get(`${RENTCAST_BASE}/avm/rent/long-term`, {
      headers: { "X-Api-Key": process.env.RENTCAST_API_KEY },
      params: {
        address,
        maxRadius: radius,
        compCount: limit
      },
      timeout: 20000
    });

    res.json({ ok: true, type: "nearby_rentals", data: r.data });
  } catch (err) {
    res.status(err.response?.status || 500).json({
      ok: false,
      type: "nearby_rentals",
      error: "Failed to fetch nearby rentals",
      details: err.response?.data || { message: err.message }
    });
  }
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
