const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const BASE_URL = 'https://api.level.travel';
const HEADERS = {
    Accept: 'application/vnd.leveltravel.v3.7',
    Authorization: 'Token token="6a6ca82f341fea2a9d19b0d581c448e7"',
    'Content-Type': 'application/json'
};
const HEADERS_3_8 = {
    Accept: 'application/vnd.leveltravel.v3.8',
    Authorization: 'Token token="6a6ca82f341fea2a9d19b0d581c448e7"',
    'Content-Type': 'application/json'
};

app.get('/references/departures', async (req, res) => {
    try {
        const response = await axios.get(`${BASE_URL}/references/departures`, {
            params: req.query,
            headers: HEADERS,
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error departures:', error.message);
        res.status(500).json({ error: 'Failed departures' });
    }
});

app.get('/references/destinations', async (req, res) => {
    try {
        const response = await axios.get(`${BASE_URL}/references/destinations`, {
            params: req.query,
            headers: HEADERS,
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error destinations:', error.message);
        res.status(500).json({ error: 'Failed destinations' });
    }
});

app.get('/references/operators', async (req, res) => {
    try {
        const response = await axios.get(`${BASE_URL}/references/operators`, {
            params: req.query,
            headers: HEADERS,
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error operators:', error.message);
        res.status(500).json({ error: 'Failed operators' });
    }
});

app.get('/references/airlines', async (req, res) => {
    try {
        const response = await axios.get(`${BASE_URL}/references/airlines`, {
            params: req.query,
            headers: HEADERS,
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error airlines:', error.message);
        res.status(500).json({ error: 'Failed airlines' });
    }
});

app.get('/references/airports', async (req, res) => {
    try {
        const response = await axios.get(`${BASE_URL}/references/airports`, {
            params: req.query,
            headers: HEADERS,
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error airports:', error.message);
        res.status(500).json({ error: 'Failed airports' });
    }
});

app.get('/references/hotels', async (req, res) => {
    try {
        const response = await axios.get(`${BASE_URL}/references/hotels`, {
            params: req.query,
            headers: HEADERS,
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error hotels:', error.message);
        res.status(500).json({ error: 'Failed hotels' });
    }
});

app.get('/references/hotel_dump', async (req, res) => {
    try {
        const response = await axios.get(`${BASE_URL}/references/hotel_dump`, {
            params: req.query,
            headers: HEADERS,
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error hotel_dump:', error.message);
        res.status(500).json({ error: 'Failed hotel_dump' });
    }
});

app.get('/references/flights_and_nights', async (req, res) => {
    try {
        const response = await axios.get(`${BASE_URL}/references/flights_and_nights`, {
            params: req.query,
            headers: HEADERS,
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error flights_and_nights:', error.message);
        res.status(500).json({ error: `Failed flights_and_nights ${error.message}` });
    }
});





app.get('/start-search', async (req, res) => {
    try {
        console.log(req.query)
        const response = await axios.get(`${BASE_URL}/search/enqueue`, {
            params: req.query,
            headers: HEADERS,
        });
        res.json(response.data);
    } catch (error) {

        console.log({...error.message})
        // console.error('Error starting search:', error.message);
        res.status(500).json({ error: 'Failed to start search' });
    }
});

app.get('/packages/package_details', async (req, res) => {
    try {
        console.log(req.query)
        const response = await axios.get(`${BASE_URL}/packages/package_details`, {
            params: req.query,
            headers: HEADERS,
        });
        res.json(response.data);
    } catch (error) {

        // console.log({...error.message})
        console.error('Error starting  :', error.message);
        res.status(500).json({ error: 'Failed to start search' });
    }
});
app.get('/packages/actualize', async (req, res) => {
    try {
        console.log(req.query)
        const response = await axios.get(`${BASE_URL}/packages/actualize`, {
            params: req.query,
            headers: HEADERS,
        });
        res.json(response.data);
    } catch (error) {

        // console.log({...error.message})
        console.error('Error starting  :', error.message);
        res.status(500).json({ error: 'Failed to start search' });
    }
});


app.get('/search-status', async (req, res) => {
    try {
        const { request_id } = req.query;
        if (!request_id) {
            return res.status(400).json({ error: 'Missing request_id' });
        }

        const response = await axios.get(`${BASE_URL}/search/status`, {
            params: { request_id },
            headers: HEADERS,
        });

        res.json(response.data);
    } catch (error) {
        console.error('Error checking status:', error.message);
        res.status(500).json({ error: 'Failed to check status' });
    }
});

app.get('/grouped-hotels', async (req, res) => {
    try {
        const {
            request_id,
            operator_ids,
            filter_instant_confirm,
            filter_rating,
            filter_price_min,
            filter_price_max,
            filter_stars,
            filter_regions,
            filter_hotel_type,
            filter_meals,
            filter_operators,
            filter_line
        } = req.query;

        if (!request_id) {
            return res.status(400).json({ error: 'Missing request_id' });
        }

        const params = {
            request_id,
            filter_instant_confirm:filter_instant_confirm,
            ...(operator_ids && { operator_ids }),
            ...(filter_rating && { filter_rating }),
            ...(filter_price_min && { filter_price_min }),
            ...(filter_price_max && { filter_price_max }),
            ...(filter_stars && { filter_stars }),
            ...(filter_regions && { filter_regions }),
            ...(filter_hotel_type && { filter_hotel_type }),
            ...(filter_meals && { filter_meals }),
            ...(filter_operators && { filter_operators }),
            ...(filter_line && { filter_line }),
        };

        console.log('params',params)

        const response = await axios.get(`${BASE_URL}/search/get_grouped_hotels`, {
            params,
            headers: HEADERS,
        });

        res.json(response.data);
    } catch (error) {
        console.error('Error getting grouped hotels:', error.message);
        res.status(500).json({ error: 'Failed to get grouped hotels' });
    }
});

app.get('/hotels-rooms', async (req, res) => {
    try {
        const {
            request_id,
            hotel_id
        } = req.query;

        if (!request_id) {
            return res.status(400).json({ error: 'Missing request_id' });
        }

        const params = {
            request_id,
            hotel_id
        };


        const response = await axios.get(`${BASE_URL}/search/hotel_rooms`, {
            params,
            headers: HEADERS,
        });

        res.json(response.data);
    } catch (error) {
        console.error('Error getting grouped hotels rooms:', error.message);
        res.status(500).json({ error: 'Failed to get grouped hotels' });
    }
});


app.get('/get-hotel-offers', async (req, res) => {
    try {
        const { request_id, operator_ids, hotel_id, compact } = req.query;

        console.log('req.query',req.query)
        if (!request_id || !hotel_id) {
            return res.status(400).json({ error: 'Missing request_id or hotel_id' });
        }

        const params = {
            request_id,
            hotel_id,
        };

        if (operator_ids) params.operator_ids = operator_ids;
        if (compact !== undefined) params.compact = compact;

        const response = await axios.get(`${BASE_URL}/get_hotel_offers`, {
            params,
            headers: HEADERS,
        });

        res.json(response.data);
    } catch (error) {
        console.error('Error getting hotel offers:', error.message);
        res.status(500).json({ error: 'Failed to get hotel offers' });
    }
});



app.post('/packages/flights', async (req, res) => {
    try {
        console.log('aaaaaa', req.body);
        const response = await axios.post(`${BASE_URL}/packages/flights`, req.body, {
            headers: HEADERS_3_8,
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error flights  :', error.message);
        res.status(500).json({ error: 'Failed to start search' });
    }
});


const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Level Travel proxy API running on port ${PORT}`);
});
