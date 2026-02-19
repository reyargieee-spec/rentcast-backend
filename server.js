require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();

app.use(cors({ origin: "*" }));
app.options("*", cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("RentCast backend is running");
});

app.get("/ping", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/property", async (req, res) => {
  try {
    const address = req.query.address;

    if (!address) {
      return res.status(400).json({ error: "Address is required" });
    }

    const response = await axios.get("https://api.rentcast.io/v1/properties", {
      headers: { "X-Api-Key": process.env.RENTCAST_API_KEY },
      params: { address }
    });

    res.json(response.data);

  } catch (error) {
    const status = error.response?.status || 500;
    const details = error.response?.data || { message: error.message };

    console.error("RentCast error:", details);

    return res.status(status).json({
      error: "Failed to fetch property data",
      details
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
