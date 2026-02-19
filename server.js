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
    res.status(500).json({
      error: "Failed to fetch property data",
      details: error.response?.data || error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
