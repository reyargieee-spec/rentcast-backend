require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("RentCast backend is running");
});

// ✅ Health check (Render friendly)
app.get("/ping", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ✅ Exact property lookup
app.get("/api/property", async (req, res) => {
  try {
    const address = (req.query.address || "").trim();

    if (!address) {
      return res.status(400).json({ error: "Address is required" });
    }

    const response = await axios.get("https://api.rentcast.io/v1/properties", {
      headers: { "X-Api-Key": process.env.RENTCAST_API_KEY },
      params: { address },
      timeout: 20000
    });

    return res.json(response.data);
  } catch (error) {
    const status = error.response?.status || 500;
    const details = error.response?.data || { message: error.message };

    return res.status(status).json({
      error: "Failed to fetch property data",
      details
    });
  }
});

/**
 * ✅ Nearby rental comps (like RentCast "Comparable Listings")
 * Uses RentCast AVM rent endpoint that can return comps/comparables
 *
 * URL:
 * /api/nearby-rentals?address=...&radius=0.5&limit=10
 */
app.get("/api/nearby-rentals", async (req, res) => {
  const address = (req.query.address || "").trim();
  if (!address) {
    return res.status(400).json({ ok: false, error: "address is required" });
  }

  const radius = Number(req.query.radius ?? 0.5);
  const limit = Math.min(Number(req.query.limit ?? 10), 25);

  try {
    // NOTE:
    // Some RentCast plans return comps under `comparables` or `comps`.
    // This endpoint is the one most likely to return rental comps.
    const r = await axios.get("https://api.rentcast.io/v1/avm/rent/long-term", {
      headers: { "X-Api-Key": process.env.RENTCAST_API_KEY },
      params: {
        address,
        maxRadius: radius,
        compCount: limit
      },
      timeout: 20000
    });

    const rawComps = r.data?.comparables || r.data?.comps || [];

    const comps = rawComps.map((c) => ({
      address: c.address || c.formattedAddress || "",
      listedRent: c.listedRent ?? c.rent ?? null,
      distance: c.distance ?? null,
      similarity: c.similarity ?? null,
      beds: c.bedrooms ?? c.beds ?? null,
      baths: c.bathrooms ?? c.baths ?? null,
      sqft: c.squareFeet ?? c.sqft ?? null,
      type: c.propertyType || c.type || null,
      lastSeen: c.lastSeen || c.lastSeenDate || null
    }));

    return res.json({
      ok: true,
      address,
      radius,
      limit,
      count: comps.length,
      comps
    });
  } catch (error) {
    const status = error.response?.status || 500;
    const details = error.response?.data || { message: error.message };

    return res.status(status).json({
      ok: false,
      error: "Failed to fetch nearby rentals",
      details
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
