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
const REALIE_BASE_URL = process.env.REALIE_BASE_URL || "https://app.realie.ai/api";

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const NOMINATIM_UA =
  process.env.NOMINATIM_USER_AGENT ||
  "RentCastPanel/1.0 (contact: your-real-email@domain.com)";

const CENSUS_API_KEY = process.env.CENSUS_API_KEY;

// ==============================
// Health checks
// ==============================
app.get("/", (req, res) => res.send("Backend is running"));
app.get("/ping", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ✅ Debug: verify env is loaded on Render
app.get("/api/debug/env", (req, res) => {
  res.json({
    ok: true,
    hasRentcastKey: Boolean(RENTCAST_API_KEY),
    hasRealieKey: Boolean(REALIE_API_KEY),
    hasCensusKey: Boolean(CENSUS_API_KEY),
    hasNominatimUA: Boolean(process.env.NOMINATIM_USER_AGENT),
    realieBaseUrl: REALIE_BASE_URL,
    time: new Date().toISOString(),
  });
});

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

function round2(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
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
// FREE Helpers: Geocode + Census
// ==============================
async function geocodeToZip(address) {
  try {
    const url = `${NOMINATIM_BASE}/search`;

    const r = await axios.get(url, {
      params: { q: address, format: "json", addressdetails: 1, limit: 1 },
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
    return null;
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
  if (CENSUS_API_KEY) params.key = CENSUS_API_KEY;

  try {
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
      totalHousing && vacantUnits != null ? round2((vacantUnits / totalHousing) * 100) : null;

    const ownerShare = occupied ? round2((ownerUnits / occupied) * 100) : null;
    const renterShare = occupied ? round2((renterUnits / occupied) * 100) : null;

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
  } catch (err) {
    console.warn("Census failed:", err.response?.status || err.message, err.response?.data || "");
    return null;
  }
}

app.get("/api/census/ping", async (req, res) => {
  const zip = (req.query.zip || "").trim();
  if (!zip) return res.status(400).json({ ok: false, error: "zip is required (e.g., 44128)" });
  const data = await fetchCensusByZip(zip);
  res.json({
    ok: Boolean(data),
    zip,
    hasKey: Boolean(CENSUS_API_KEY),
    demographics: data,
  });
});

// ==============================
// Simple AVM + ARV
// ==============================
function computeSimpleAVM({ subjectSqft, saleComps = [], rentEstimateMonthly, capRatePercent = 8.0 }) {
  const sqft = Number(subjectSqft);

  const validComps = (saleComps || [])
    .map((c) => ({ price: Number(c.price), sqft: Number(c.sqft) }))
    .filter((c) => Number.isFinite(c.price) && c.price > 0 && Number.isFinite(c.sqft) && c.sqft > 0);

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

function computeInvestmentSummary({
  purchasePrice,
  monthlyRent,
  vacancyPercent = 5,
  expensePercent = 35,
  downPaymentPercent = 20,
  interestRatePercent = 7.5,
  loanYears = 30,
}) {
  const P = Number(purchasePrice);
  const R = Number(monthlyRent);

  if (!Number.isFinite(P) || P <= 0) return { ok: false, error: "purchasePrice missing/invalid" };
  if (!Number.isFinite(R) || R <= 0) return { ok: false, error: "monthlyRent missing/invalid" };

  const vacancy = Number(vacancyPercent) / 100;
  const expense = Number(expensePercent) / 100;
  const dp = Number(downPaymentPercent) / 100;

  const grossAnnual = R * 12;
  const effectiveGross = grossAnnual * (1 - vacancy);
  const operatingExpenses = effectiveGross * expense;
  const noi = effectiveGross - operatingExpenses;

  const grm = P / grossAnnual;
  const capRate = (noi / P) * 100;

  const loanAmount = P * (1 - dp);
  const monthlyRate = (Number(interestRatePercent) / 100) / 12;
  const n = Number(loanYears) * 12;

  let monthlyDebt = 0;
  if (loanAmount > 0 && monthlyRate > 0 && n > 0) {
    monthlyDebt = (loanAmount * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -n));
  } else if (loanAmount > 0 && n > 0) {
    monthlyDebt = loanAmount / n;
  }

  const annualDebt = monthlyDebt * 12;
  const cashFlowAnnual = noi - annualDebt;
  const cashFlowMonthly = cashFlowAnnual / 12;

  const cashInvested = P * dp;
  const coc = cashInvested > 0 ? (cashFlowAnnual / cashInvested) * 100 : null;

  return {
    ok: true,
    assumptions: {
      vacancyPercent,
      expensePercent,
      downPaymentPercent,
      interestRatePercent,
      loanYears,
    },
    gross: {
      monthlyRent: R,
      grossAnnual,
      effectiveGrossAnnual: Math.round(effectiveGross),
    },
    noi: {
      operatingExpensesAnnual: Math.round(operatingExpenses),
      noiAnnual: Math.round(noi),
    },
    metrics: {
      grm: round2(grm),
      capRatePercent: round2(capRate),
      cashOnCashPercent: coc != null ? round2(coc) : null,
    },
    debt: {
      purchasePrice: P,
      loanAmount: Math.round(loanAmount),
      monthlyPaymentPI: Math.round(monthlyDebt),
      annualDebtService: Math.round(annualDebt),
    },
    cashFlow: {
      monthly: Math.round(cashFlowMonthly),
      annual: Math.round(cashFlowAnnual),
    },
  };
}

// ==============================
// RentCast endpoints
// ==============================
app.get("/api/property", async (req, res) => {
  try {
    const address = (req.query.address || "").trim();
    if (!address) return res.status(400).json({ error: "Address is required" });

    if (!RENTCAST_API_KEY) return res.status(500).json({ error: "RENTCAST_API_KEY not set" });

    const response = await axios.get("https://api.rentcast.io/v1/properties", {
      headers: { "X-Api-Key": RENTCAST_API_KEY, Accept: "application/json" },
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

  if (!RENTCAST_API_KEY) return res.status(500).json({ ok: false, error: "RENTCAST_API_KEY not set" });

  try {
    const r = await axios.get("https://api.rentcast.io/v1/avm/rent/long-term", {
      headers: { "X-Api-Key": RENTCAST_API_KEY, Accept: "application/json" },
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
      return res.json({
        ok: true,
        address,
        radius,
        limit,
        count: 0,
        comps: [],
        note: "No comps found",
        rentcastStatus: status,
      });
    }

    res.status(status).json({ ok: false, error: "Failed to fetch nearby rentals", details });
  }
});

// ==============================
// Realie endpoints
// ==============================
app.get("/api/realie/ping", (req, res) => {
  res.json({
    ok: true,
    hasKey: Boolean(REALIE_API_KEY),
    baseUrl: REALIE_BASE_URL,
    time: new Date().toISOString(),
  });
});

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

    const url = `${REALIE_BASE_URL}/public/property/address/`;

    const params = { state, address: addressLine1 };
    if (unitNumberStripped) params.unitNumberStripped = unitNumberStripped;
    if (city) params.city = city;
    if (county) params.county = county;

    const r = await axios.get(url, {
      headers: { Authorization: REALIE_API_KEY, Accept: "application/json" },
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

// ==============================
// Realie sale comps helpers
// ==============================
function normalizeSaleComp(x) {
  const price =
    toNumberLoose(pickFirst(x, ["salePrice", "lastSalePrice", "transferPrice", "price"])) ?? null;

  const sqft =
    toNumberLoose(pickFirst(x, ["buildingArea", "livingArea", "squareFeet", "sqft"])) ?? null;

  const soldDate =
    pickFirst(x, ["saleDate", "lastSaleDate", "transferDate", "recordingDate"]) ?? null;

  const address =
    pickFirst(x, ["address", "formattedAddress", "addressFull", "addressFullUSPS"]) ?? "";

  return {
    address,
    price,
    sqft,
    soldDate,
    ppsf: price && sqft ? round2(price / sqft) : null,
    raw: x,
  };
}

async function fetchRealieSaleComps({ state, county, subjectSqft, limit = 10 }) {
  if (!REALIE_API_KEY || !state || !county) return { ok: false, comps: [], source: null };

  // 1) Try premium comparables
  try {
    const url = `${REALIE_BASE_URL}/public/premium/comparables/`;
    const params = { state, county, limit };

    const r = await axios.get(url, {
      headers: { Authorization: REALIE_API_KEY, Accept: "application/json" },
      params,
      timeout: 20000,
    });

    const rows = r.data?.comparables || r.data?.data || r.data || [];
    const comps = (Array.isArray(rows) ? rows : [])
      .map(normalizeSaleComp)
      .filter((c) => c.price && c.sqft);

    if (comps.length) return { ok: true, comps, source: "realie_premium_comparables" };
  } catch (e) {
    // fallback
  }

  // 2) Fallback search
  try {
    const url = `${REALIE_BASE_URL}/public/property/search/`;
    const params = { state, county, limit: Math.max(limit * 5, 50), offset: 0 };

    const r = await axios.get(url, {
      headers: { Authorization: REALIE_API_KEY, Accept: "application/json" },
      params,
      timeout: 20000,
    });

    const rows = r.data?.results || r.data?.data || r.data?.properties || r.data || [];
    const arr = Array.isArray(rows) ? rows : [];

    let comps = arr.map(normalizeSaleComp).filter((c) => c.price && c.sqft);

    const s = Number(subjectSqft);
    if (Number.isFinite(s) && s > 0) {
      comps = comps
        .map((c) => ({ ...c, sqftDiff: Math.abs(c.sqft - s) }))
        .sort((a, b) => (a.sqftDiff ?? 9e9) - (b.sqftDiff ?? 9e9))
        .slice(0, limit)
        .map(({ sqftDiff, ...rest }) => rest);
    } else {
      comps = comps.slice(0, limit);
    }

    return { ok: true, comps, source: "realie_county_search_fallback" };
  } catch (e) {
    return { ok: false, comps: [], source: null };
  }
}

function computeARVFromComps({ subjectSqft, saleComps }) {
  const sqft = Number(subjectSqft);
  if (!Number.isFinite(sqft) || sqft <= 0) {
    return { ok: false, arv: null, avgPpsf: null, compsUsed: 0, reason: "subjectSqft missing" };
  }

  const valid = (saleComps || []).filter(
    (c) =>
      c.price &&
      c.sqft &&
      Number.isFinite(c.price) &&
      Number.isFinite(c.sqft) &&
      c.price > 0 &&
      c.sqft > 0
  );
  if (!valid.length) {
    return { ok: false, arv: null, avgPpsf: null, compsUsed: 0, reason: "no valid sale comps" };
  }

  const avgPpsf = valid.reduce((sum, c) => sum + c.price / c.sqft, 0) / valid.length;
  const arv = Math.round(avgPpsf * sqft);

  return {
    ok: true,
    arv,
    avgPpsf: round2(avgPpsf),
    compsUsed: valid.length,
    method: "avg comps $/sqft × subject sqft",
  };
}

// ==============================
// ✅ Property Panel (MASTER)
// ==============================
app.get("/api/property-panel", async (req, res) => {
  const fullAddress = (req.query.fullAddress || req.query.address || "").trim();
  const capRatePercent = Number(req.query.cap || 8);

  let state = (req.query.state || "").trim().toUpperCase();
  let addressLine1 = (req.query.addressLine1 || "").trim();
  let city = (req.query.city || "").trim();
  let county = (req.query.county || "").trim();

  const purchasePrice = toNumberLoose(req.query.purchasePrice);
  const vacancyPercent = toNumberLoose(req.query.vacancyPercent) ?? 5;
  const expensePercent = toNumberLoose(req.query.expensePercent) ?? 35;
  const downPaymentPercent = toNumberLoose(req.query.downPaymentPercent) ?? 20;
  const interestRatePercent = toNumberLoose(req.query.interestRatePercent) ?? 7.5;
  const loanYears = toNumberLoose(req.query.loanYears) ?? 30;

  if (!fullAddress && !(state && addressLine1)) {
    return res.status(400).json({
      ok: false,
      error: "Provide either fullAddress OR (state + addressLine1).",
    });
  }

  const warnings = [];

  try {
    // Geocode
    const geo = fullAddress ? await geocodeToZip(fullAddress) : null;
    const zip = geo?.zip || null;

    if (fullAddress && !geo) warnings.push("Geocoding failed (Nominatim). Check NOMINATIM_USER_AGENT + address format.");

    // Census
    const demographics = zip ? await fetchCensusByZip(zip) : null;

    // Derive addressLine1 if missing
    if (!addressLine1 && fullAddress) {
      addressLine1 = fullAddress.split(",")[0].trim();
      if (addressLine1) warnings.push("addressLine1 was not provided; derived from fullAddress.");
    }

    // Derive county/city from geo if missing
    if (!county && geo?.raw?.county) {
      county = String(geo.raw.county).replace(/ County$/i, "").trim();
      if (county) warnings.push("county was not provided; derived from geocoding result.");
    }

    if (!city) {
      city = geo?.raw?.city || geo?.raw?.town || geo?.raw?.village || city;
    }

    // RentCast
    let rentcastData = null;
    let rentcastProp = null;

    if (!RENTCAST_API_KEY) {
      warnings.push("RENTCAST_API_KEY missing. RentCast calls skipped.");
    } else if (fullAddress) {
      try {
        const rentcastResp = await axios.get("https://api.rentcast.io/v1/properties", {
          headers: { "X-Api-Key": RENTCAST_API_KEY, Accept: "application/json" },
          params: { address: fullAddress },
          timeout: 20000,
        });

        rentcastData = rentcastResp.data;
        rentcastProp = Array.isArray(rentcastData) ? rentcastData[0] : rentcastData;

        if (!rentcastProp) warnings.push("RentCast returned no property for this address.");
      } catch (e) {
        warnings.push(`RentCast /v1/properties failed: ${e.response?.status || ""} ${JSON.stringify(e.response?.data || e.message)}`);
      }
    } else {
      warnings.push("No fullAddress provided, so RentCast lookup skipped.");
    }

    // Realie
    let realie = null;
    if (!REALIE_API_KEY) {
      warnings.push("REALIE_API_KEY missing. Realie calls skipped.");
    } else if (state && addressLine1) {
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
        if (!realie) warnings.push("Realie returned no property record for this address.");
      } catch (e) {
        warnings.push(`Realie address lookup failed: ${e.response?.status || ""} ${JSON.stringify(e.response?.data || e.message)}`);
      }
    } else {
      warnings.push("state + addressLine1 missing; Realie lookup skipped.");
    }

    // Subject sqft
    const subjectSqft =
      toNumberLoose(pickFirst(rentcastProp, ["squareFeet", "sqft", "livingArea", "area", "sizeSqft"])) ??
      toNumberLoose(pickFirst(realie, ["buildingArea", "livingArea", "squareFeet", "sqft"])) ??
      null;

    // Rent estimate
    const rentEstimateMonthly =
      toNumberLoose(pickFirst(rentcastProp, ["rentEstimate", "rent", "estimatedRent", "rentEstimateMonthly"])) ??
      null;

    // Sold comps (Realie needs state+county)
    const compsLimit = Math.min(toNumberLoose(req.query.saleCompLimit) ?? 10, 20);
    const saleCompsResp = await fetchRealieSaleComps({ state, county, subjectSqft, limit: compsLimit });
    const saleComps = saleCompsResp.ok ? saleCompsResp.comps : [];
    if (!saleCompsResp.ok) warnings.push("Sold comps unavailable (Realie requires BOTH state + county).");

    // ARV
    const arv = computeARVFromComps({ subjectSqft, saleComps });

    // AVM
    const avm = computeSimpleAVM({
      subjectSqft,
      rentEstimateMonthly,
      capRatePercent,
      saleComps: saleComps.map((c) => ({ price: c.price, sqft: c.sqft })),
    });

    // Purchase price fallback
    const fallbackPrice =
      purchasePrice ??
      toNumberLoose(pickFirst(rentcastProp, ["lastSalePrice", "salePrice", "price"])) ??
      toNumberLoose(pickFirst(realie, ["transferPrice", "lastSalePrice", "marketValue", "totalMarketValue"])) ??
      null;

    // Investment summary
    const investment =
      fallbackPrice && rentEstimateMonthly
        ? computeInvestmentSummary({
            purchasePrice: fallbackPrice,
            monthlyRent: rentEstimateMonthly,
            vacancyPercent,
            expensePercent,
            downPaymentPercent,
            interestRatePercent,
            loanYears,
          })
        : {
            ok: false,
            reason: "Need purchase price + monthly rent estimate.",
            purchasePrice: fallbackPrice ?? null,
            monthlyRent: rentEstimateMonthly ?? null,
          };

    res.setHeader("Cache-Control", "public, max-age=60");

    res.json({
      ok: true,
      warnings,
      inputs: { fullAddress, state, addressLine1, city, county },
      geocoding: geo ? { lat: geo.lat, lon: geo.lon, zip: geo.zip, raw: geo.raw } : null,
      demographics,
      rentcast: rentcastData,
      realie,
      saleComps: {
        ok: saleCompsResp.ok,
        source: saleCompsResp.source,
        count: saleComps.length,
        comps: saleComps.map((c) => ({
          address: c.address,
          price: c.price,
          sqft: c.sqft,
          ppsf: c.ppsf,
          soldDate: c.soldDate,
        })),
      },
      subject: {
        sqft: subjectSqft,
        rentEstimateMonthly,
        purchasePriceUsed: fallbackPrice,
      },
      arv,
      avm,
      investment,
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