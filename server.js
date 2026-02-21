require("dotenv").config();

const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ==============================
// ENV
// ==============================
const RENTCAST_API_KEY = process.env.RENTCAST_API_KEY;
const REALIE_API_KEY = process.env.REALIE_API_KEY;

// Realie public API base (this is the correct host for API calls)
const REALIE_BASE_URL = process.env.REALIE_BASE_URL || "https://app.realie.ai/api";

// ==============================
// Health checks
// ==============================
app.get("/", (req, res) => res.send("Backend is running"));
app.get("/ping", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ==============================
// Helpers
// ==============================
function pickFirst(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

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

function normalizeComp(c) {
  const addr =
    pickFirst(c, ["formattedAddress", "address", "fullAddress"]) ||
    pickFirst(c?.property, ["formattedAddress", "address"]) ||
    "";

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
      "rentAmount",
    ]) ??
    pickFirst(c?.pricing, ["rent", "price", "monthlyRent", "listPrice", "listingPrice"]) ??
    pickFirst(c?.listing, ["rent", "price", "monthlyRent", "listPrice", "listingPrice"]) ??
    pickFirst(c?.avm, ["rent", "rentEstimate"]);

  const listedRent = toNumberLoose(rentRaw);

  const sqftRaw =
    pickFirst(c, [
      "squareFeet",
      "sqft",
      "livingArea",
      "area",
      "sizeSqft",
      "buildingSize",
      "squareFootage",
      "livingAreaSquareFeet",
    ]) ??
    pickFirst(c?.property, ["squareFeet", "sqft", "livingArea", "area", "sizeSqft"]) ??
    pickFirst(c?.listing, ["squareFeet", "sqft", "livingArea", "area", "sizeSqft"]) ??
    pickFirst(c?.features, ["squareFeet", "sqft", "livingArea"]);

  const sqft = toNumberLoose(sqftRaw);

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
    pickFirst(c, ["propertyType", "type"]) ??
    pickFirst(c?.property, ["propertyType", "type"]) ??
    null;

  const lastSeen =
    pickFirst(c, ["lastSeen", "lastSeenDate", "lastSeenAt", "lastUpdated", "updatedAt"]) ??
    null;

  return { address: addr, listedRent, distance, similarity, beds, baths, sqft, type, lastSeen };
}

// ==============================
// FREE Helpers: Geocode + Census + Simple AVM
// ==============================
const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";

const NOMINATIM_UA =
  process.env.NOMINATIM_USER_AGENT ||
  "RentCastPanel/1.0 (contact: your-real-email@domain.com)";

async function geocodeToZip(address) {
  try {
    const url = `${NOMINATIM_BASE}/search`;

    const r = await axios.get(url, {
      params: {
        q: address,
        format: "json",
        addressdetails: 1,
        limit: 1,
      },
      headers: {
        "User-Agent": NOMINATIM_UA,
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 20000,
    });

    const hit = r.data?.[0];
    if (!hit) return null;

    return {
      zip: hit.address?.postcode || null,
      lat: hit.lat ? Number(hit.lat) : null,
      lon: hit.lon ? Number(hit.lon) : null,
      raw: hit.address,
    };
  } catch (err) {
    console.warn("Geocode failed:", err.response?.status || err.message);
    return null; // IMPORTANT: do not crash the whole panel
  }
}

async function fetchCensusByZip(zip) {
  if (!zip) return null;

  const zip5 = String(zip).trim().slice(0, 5);
  if (!/^\d{5}$/.test(zip5)) return null;

  const base = "https://api.census.gov/data/2022/acs/acs5";
  const fields = [
    "B01003_001E",
    "B19013_001E",
    "B25064_001E",
    "B25077_001E",
    "B25003_002E",
    "B25003_003E",
    "B25004_001E",
    "B25002_001E",
  ].join(",");

  const params = { get: fields, for: `zip code tabulation area:${zip5}` };
  if (process.env.CENSUS_API_KEY) params.key = process.env.CENSUS_API_KEY;

  const r = await axios.get(base, { params, timeout: 20000 });
  const rows = r.data;
  if (!Array.isArray(rows) || rows.length < 2) return null;

  const headers = rows[0];
  const values = rows[1];
  const obj = {};
  headers.forEach((h, i) => (obj[h] = values[i]));

  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };

  const totalHousing = n(obj.B25002_001E);
  const vacantUnits = n(obj.B25004_001E);
  const ownerUnits = n(obj.B25003_002E);
  const renterUnits = n(obj.B25003_003E);

  const occupied = (ownerUnits ?? 0) + (renterUnits ?? 0);

  const vacancyRate =
    totalHousing && vacantUnits != null
      ? Math.round((vacantUnits / totalHousing) * 1000) / 10
      : null;

  const ownerShare = occupied ? Math.round((ownerUnits / occupied) * 1000) / 10 : null;
  const renterShare = occupied ? Math.round((renterUnits / occupied) * 1000) / 10 : null;

  return {
    zip: zip5,
    population: n(obj.B01003_001E),
    medianHouseholdIncome: n(obj.B19013_001E),
    medianGrossRent: n(obj.B25064_001E),
    medianHomeValueAreaProxy: n(obj.B25077_001E),
    totalHousingUnits: totalHousing,
    vacantHousingUnits: vacantUnits,
    vacancyRatePercent: vacancyRate,
    ownerOccupiedUnits: ownerUnits,
    renterOccupiedUnits: renterUnits,
    ownerOccupiedSharePercent: ownerShare,
    renterOccupiedSharePercent: renterShare,
    source: "US Census ACS 5-year (ZCTA)",
    year: 2022,
  };
}

function computeSimpleAVM({ subjectSqft, saleComps = [], rentEstimateMonthly, capRatePercent = 8.0 }) {
  const sqft = Number(subjectSqft);

  const validComps = (saleComps || [])
    .map((c) => ({ price: Number(c.price), sqft: Number(c.sqft) }))
    .filter((c) => Number.isFinite(c.price) && c.price > 0 && Number.isFinite(c.sqft) && c.sqft > 0);

  // A) comps-based AVM
  if (Number.isFinite(sqft) && sqft > 0 && validComps.length) {
    const avgPpsf = validComps.reduce((sum, c) => sum + c.price / c.sqft, 0) / validComps.length;
    const avm = Math.round(avgPpsf * sqft);
    return {
      method: "Sale comps avg $/sqft × subject sqft",
      estimatedMarketValue: avm,
      inputs: { subjectSqft: sqft, compsUsed: validComps.length, avgPricePerSqft: Math.round(avgPpsf) },
      confidence: validComps.length >= 5 ? "medium" : "low",
      label: "Estimate (Algorithmic)",
    };
  }

  // B) rent-cap AVM fallback
  const rent = Number(rentEstimateMonthly);
  const cap = Number(capRatePercent);
  if (Number.isFinite(rent) && rent > 0 && Number.isFinite(cap) && cap > 0) {
    const noiAnnual = rent * 12;
    const avm = Math.round(noiAnnual / (cap / 100));
    return {
      method: "Rent estimate annualized ÷ cap rate",
      estimatedMarketValue: avm,
      inputs: { rentEstimateMonthly: rent, capRatePercent: cap },
      confidence: "low",
      label: "Estimate (Algorithmic)",
    };
  }

  return { method: "Insufficient inputs", estimatedMarketValue: null, confidence: "none", label: "Estimate (Algorithmic)" };
}

// ==============================
// RentCast Endpoints
// ==============================
app.get("/api/property", async (req, res) => {
  try {
    const address = (req.query.address || "").trim();
    if (!address) return res.status(400).json({ error: "Address is required" });

    const response = await axios.get("https://api.rentcast.io/v1/properties", {
      headers: { "X-Api-Key": RENTCAST_API_KEY },
      params: { address },
      timeout: 20000,
    });

    res.json(response.data);
  } catch (error) {
    const status = error.response?.status || 500;
    const details = error.response?.data || { message: error.message };
    res.status(status).json({ error: "Failed to fetch property data", details });
  }
});

app.get("/api/nearby-rentals", async (req, res) => {
  const address = (req.query.address || "").trim();
  if (!address) return res.status(400).json({ ok: false, error: "address is required" });

  const radius = Number(req.query.radius ?? 0.5);
  const limit = Math.min(Number(req.query.limit ?? 10), 25);

  try {
    const r = await axios.get("https://api.rentcast.io/v1/avm/rent/long-term", {
      headers: { "X-Api-Key": RENTCAST_API_KEY },
      params: { address, maxRadius: radius, compCount: limit },
      timeout: 20000,
    });

    const rawComps = r.data?.comparables || r.data?.comps || [];
    const comps = rawComps.map(normalizeComp);

    res.json({ ok: true, address, radius, limit, count: comps.length, comps });
  } catch (error) {
    const status = error.response?.status || 500;
    const details = error.response?.data || { message: error.message };

    const treatAsEmpty = [400, 404, 422].includes(status);
    if (treatAsEmpty) {
      return res.json({ ok: true, address, radius, limit, count: 0, comps: [], note: "No comps found", rentcastStatus: status });
    }

    res.status(status).json({ ok: false, error: "Failed to fetch nearby rentals", details });
  }
});

// ==============================
// Realie Endpoints (Public API)
// ==============================

// sanity check
app.get("/api/realie/ping", (req, res) => {
  res.json({
    ok: true,
    hasKey: Boolean(REALIE_API_KEY),
    baseUrl: REALIE_BASE_URL,
    time: new Date().toISOString(),
  });
});

// GET /api/realie/address-lookup?state=OH&addressLine1=3894%20E%20144TH%20ST&city=CLEVELAND&county=CUYAHOGA
app.get("/api/realie/address-lookup", async (req, res) => {
  try {
    if (!REALIE_API_KEY) return res.status(500).json({ ok: false, error: "REALIE_API_KEY is not set." });

    const state = (req.query.state || "").trim().toUpperCase();
    const addressLine1 = (req.query.addressLine1 || "").trim();
    const city = (req.query.city || "").trim();
    const county = (req.query.county || "").trim();
    const unitNumberStripped = (req.query.unitNumberStripped || "").trim();

    if (!state) return res.status(400).json({ ok: false, error: "state is required (e.g., OH)" });
    if (!addressLine1) return res.status(400).json({ ok: false, error: "addressLine1 is required (street line 1 only)" });

    // Realie endpoint per docs
    const url = `${REALIE_BASE_URL}/public/property/address/`;

    const params = { state, address: addressLine1 };
    if (unitNumberStripped) params.unitNumberStripped = unitNumberStripped;
    if (city) params.city = city;
    if (county) params.county = county;

    const r = await axios.get(url, {
      headers: {
        Authorization: REALIE_API_KEY,
        Accept: "application/json",
      },
      params,
      timeout: 20000,
    });

    res.json({ ok: true, property: r.data?.property ?? r.data ?? null, raw: r.data });
  } catch (error) {
    const status = error.response?.status || 500;
    const details = error.response?.data || { message: error.message };
    res.status(status).json({ ok: false, error: "Realie address lookup failed", details });
  }
});

// GET /api/realie/search?state=OH&county=CUYAHOGA&limit=10&offset=0
app.get("/api/realie/search", async (req, res) => {
  try {
    if (!REALIE_API_KEY) return res.status(500).json({ ok: false, error: "REALIE_API_KEY is not set." });

    const state = (req.query.state || "").trim().toUpperCase();
    if (!state) return res.status(400).json({ ok: false, error: "state is required (e.g., OH)" });

    const url = `${REALIE_BASE_URL}/public/property/search/`;

    const params = { ...req.query };
    params.state = state;

    const r = await axios.get(url, {
      headers: { Authorization: REALIE_API_KEY, Accept: "application/json" },
      params,
      timeout: 20000,
    });

    res.json({ ok: true, data: r.data });
  } catch (error) {
    const status = error.response?.status || 500;
    const details = error.response?.data || { message: error.message };
    res.status(status).json({ ok: false, error: "Realie search failed", details });
  }
});

// Premium comps (only works if your Realie plan includes premium endpoint)
app.get("/api/realie/comparables", async (req, res) => {
  try {
    if (!REALIE_API_KEY) return res.status(500).json({ ok: false, error: "REALIE_API_KEY is not set." });

    const url = `${REALIE_BASE_URL}/public/premium/comparables/`;

    const r = await axios.get(url, {
      headers: { Authorization: REALIE_API_KEY, Accept: "application/json" },
      params: { ...req.query },
      timeout: 20000,
    });

    res.json({ ok: true, data: r.data });
  } catch (error) {
    const status = error.response?.status || 500;
    const details = error.response?.data || { message: error.message };
    res.status(status).json({ ok: false, error: "Realie comparables failed", details });
  }
});

// ==============================
// Census + Demographics
// ==============================
app.get("/api/demographics", async (req, res) => {
  try {
    const address = (req.query.address || "").trim();
    const zipParam = (req.query.zip || "").trim();

    if (!address && !zipParam) {
      return res.status(400).json({ ok: false, error: "Provide address or zip." });
    }

    let zip = zipParam;
    let geo = null;

    if (!zip) {
      geo = await geocodeToZip(address);
      zip = geo?.zip || "";
    }

    if (!zip) {
      return res.status(404).json({ ok: false, error: "Could not resolve ZIP from address." });
    }

    const demographics = await fetchCensusByZip(zip);
    if (!demographics) {
      return res.status(404).json({ ok: false, error: "No census data found for ZIP." });
    }

    res.json({
      ok: true,
      zip: demographics.zip,
      geocoding: geo ? { lat: geo.lat, lon: geo.lon } : null,
      demographics,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Server error fetching demographics." });
  }
});

// ==============================
// Simple AVM
// ==============================
app.post("/api/avm", (req, res) => {
  try {
    const { subjectSqft, rentEstimateMonthly, capRatePercent, saleComps } = req.body || {};
    const avm = computeSimpleAVM({ subjectSqft, rentEstimateMonthly, capRatePercent, saleComps });
    res.json({ ok: true, avm });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Server error computing AVM." });
  }
});

// ==============================
// Property Panel (RentCast + Realie + Geo + Census + AVM)
// ==============================
// GET /api/property-panel?fullAddress=...&cap=8&state=OH&addressLine1=...&city=CLEVELAND&county=CUYAHOGA
app.get("/api/property-panel", async (req, res) => {
  const fullAddress = (req.query.fullAddress || req.query.address || "").trim();
  const capRatePercent = Number(req.query.cap || 8);

  // Realie needs these separated:
  const state = (req.query.state || "").trim().toUpperCase();
  const addressLine1 = (req.query.addressLine1 || "").trim();
  const city = (req.query.city || "").trim();
  const county = (req.query.county || "").trim();

  if (!fullAddress && !(state && addressLine1)) {
    return res.status(400).json({
      ok: false,
      error: "Provide either fullAddress OR (state + addressLine1).",
    });
  }

  try {
    // Always geocode so frontend can show a map pin even if data providers fail
    const geo = fullAddress ? await geocodeToZip(fullAddress) : null;
    const zip = geo?.zip || "";

    const demographics = zip ? await fetchCensusByZip(zip) : null;

    // 1) RentCast (optional)
    let rentcastData = null;
    let rentcastProp = null;

    if (RENTCAST_API_KEY && fullAddress) {
      try {
        const rentcastResp = await axios.get("https://api.rentcast.io/v1/properties", {
          headers: { "X-Api-Key": RENTCAST_API_KEY },
          params: { address: fullAddress },
          timeout: 20000,
        });
        rentcastData = rentcastResp.data;
        rentcastProp = Array.isArray(rentcastData) ? rentcastData[0] : rentcastData;
      } catch (e) {
        rentcastData = null;
        rentcastProp = null;
      }
    }

    // 2) Realie Address Lookup (optional)
    let realie = null;

    if (REALIE_API_KEY && state && addressLine1) {
      try {
        const url = `${REALIE_BASE_URL}/public/property/address/`;
        const params = { state, address: addressLine1 };
        if (city) params.city = city;
        if (county) params.county = county;

        const rr = await axios.get(url, {
          headers: { Authorization: REALIE_API_KEY, Accept: "application/json" },
          params,
          timeout: 20000,
        });

        realie = rr.data?.property ?? rr.data ?? null;
      } catch (e) {
        realie = null;
      }
    }

    // 3) Subject sqft + rent (try RentCast first, else Realie)
    const subjectSqft =
      toNumberLoose(pickFirst(rentcastProp, ["squareFeet", "sqft", "livingArea", "area", "sizeSqft"])) ??
      toNumberLoose(pickFirst(realie, ["buildingArea", "livingArea", "squareFeet", "sqft"])) ??
      null;

    const rentEstimateMonthly =
      toNumberLoose(pickFirst(rentcastProp, ["rentEstimate", "rent", "estimatedRent", "rentEstimateMonthly"])) ??
      null;

    // 4) AVM (free computed fallback)
    const avm = computeSimpleAVM({
      subjectSqft,
      rentEstimateMonthly,
      capRatePercent,
      saleComps: [],
    });

    res.json({
      ok: true,
      inputs: { fullAddress, state, addressLine1, city, county },
      geocoding: geo ? { lat: geo.lat, lon: geo.lon, zip: geo.zip } : null,
      demographics,
      rentcast: rentcastData,
      realie,
      avm,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Failed to build property panel", details: e.message });
  }
});

// ==============================
// Start server
// ==============================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});