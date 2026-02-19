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

// ------------------------------
// Helpers
// ------------------------------
function pickFirst(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

// Accept numbers OR strings like "$1,000" or "1,000"
function toNumberLoose(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^0-9.\-]/g, "");
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Normalize one comparable item into stable fields our frontend expects:
 * { address, listedRent, distance, similarity, beds, baths, sqft, type, lastSeen }
 */
function normalizeComp(c) {
  const addr =
    pickFirst(c, ["formattedAddress", "address", "fullAddress"]) ||
    pickFirst(c?.property, ["formattedAddress", "address"]) ||
    "";

  // RENT: try many keys, plus nested locations
  const rentRaw =
    pickFirst(c, [
      "listedRent",
      "rent",
      "price",
      "monthlyRent",
      "rentEstimate",
      "listPrice",
      "listingPrice",
      "listRent",
      "rentAmount"
    ]) ??
    pickFirst(c?.pricing, ["rent", "price", "monthlyRent", "listPrice", "listingPrice"]) ??
    pickFirst(c?.listing, ["rent", "price", "monthlyRent", "listPrice", "listingPrice"]) ??
    pickFirst(c?.avm, ["rent", "rentEstimate"]);

  const listedRent = toNumberLoose(rentRaw);

  // SQFT: try many keys, plus nested locations
  const sqftRaw =
    pickFirst(c, [
      "squareFeet",
      "sqft",
      "livingArea",
      "area",
      "sizeSqft",
      "buildingSize",
      "squareFootage",
      "livingAreaSquareFeet"
    ]) ??
    pickFirst(c?.property, ["squareFeet", "sqft", "livingArea", "area", "sizeSqft"]) ??
    pickFirst(c?.listing, ["squareFeet", "sqft", "livingArea", "area", "sizeSqft"]) ??
    pickFirst(c?.features, ["squareFeet", "sqft", "livingArea"]);

  const sqft = toNumberLoose(sqftRaw);

  // Beds/Baths: try many keys, plus nested
  const bedsRaw =
    pickFirst(c, ["bedrooms", "beds", "bed"]) ??
    pickFirst(c?.property, ["bedrooms", "beds"]) ??
    pickFirst(c?.features, ["bedrooms", "beds"]);
  const bathsRaw =
    pickFirst(c, ["bathrooms", "baths", "bath"]) ??
    pickFirst(c?.property, ["bathrooms", "baths"]) ??
    pickFirst(c?.features, ["bathrooms", "baths"]);

  const beds = toNumberLoose(bedsRaw);
  const baths = toNumberLoose(bathsRaw);

  const distance = toNumberLoose(pickFirst(c, ["distance", "dist"])) ?? null;
  const similarity = toNumberLoose(pickFirst(c, ["similarity", "score"])) ?? null;

  const type =
    pickFirst(c, ["propertyType", "type"]) ||
    pickFirst(c?.property, ["propertyType", "type"]) ||
    null;

  const lastSeen =
    pickFirst(c, ["lastSeen", "lastSeenDate", "lastSeenAt", "lastUpdated", "updatedAt"]) ||
    null;

  return {
    address: addr,
    listedRent,
    distance,
    similarity,
    beds,
    baths,
    sqft,
    type,
    lastSeen
  };
}

// ✅ Exact property lookup
app.get("/api/property", async (req, res) => {
  try {
    const address = (req.query.address || "").trim();
    if (!address) return res.status(400).json({ error: "Address is required" });

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
 * URL:
 * /api/nearby-rentals?address=...&radius=0.5&limit=10
 */
app.get("/api/nearby-rentals", async (req, res) => {
  const address = (req.query.address || "").trim();
  if (!address) return res.status(400).json({ ok: false, error: "address is required" });

  const radius = Number(req.query.radius ?? 0.5);
  const limit = Math.min(Number(req.query.limit ?? 10), 25);

  try {
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
    const comps = rawComps.map(normalizeComp);

    // Helpful debug (remove later): see if rent/sqft are coming through
    // console.log("Sample raw comp keys:", Object.keys(rawComps[0] || {}));
    // console.log("Normalized sample:", comps[0]);

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
