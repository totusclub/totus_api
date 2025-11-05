const express = require('express');
const axios = require('axios');
const cors = require('cors');
const authRoutes = require('./routes/auth.routes');
const adminAuthRoutes = require('./routes/authRoutes');
const faqRoutes = require('./routes/faq.routes');
const popularRoutes = require('./routes/popular.routes');
const contentRoutes = require('./routes/content.routes');
const pagesRoutes = require('./routes/pages.routes');
const db = require("./db");
const path = require('path');
const {json, response} = require("express");

const app = express();
app.use(cors());
app.use(express.json());

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/upload/content', express.static(path.join(__dirname, 'upload/content')));

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
app.get('/references/autocomplete_v2', async (req, res) => {
    try {
        console.log('dcd',req.query)

            const response = await axios.get(`${BASE_URL}/references/autocomplete_v2`, {
                params: req.query,
                headers: HEADERS,
            });
            res.json(response.data);


    } catch (error) {
        // console.error('Error destinations:', error.message);
        res.status(500).json({ error: error.message });
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
            filter_line,
            page_limit,
            page_number,
            sort_by
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
            ...(page_limit && { page_limit }),
            ...(page_number && { page_number }),
            ...(sort_by && { sort_by }),
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
        const response = await axios.post(`${BASE_URL}/packages/flights`, req.body, {
            headers: HEADERS_3_8,
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error flights  :', error.message);
        res.status(500).json({ error: 'Failed to start search' });
    }
});


app.post('/vtb/create-order', async (req, res) => {
    try {
        const {
            orderId,
            orderName,
            expire,
            amount,
            returnUrl
        } = req.body;
        const data = await generationBankToken()

        if (!orderId || !orderName || !expire || !amount?.value || !amount?.code || !returnUrl) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const headers = {
            "X-IBM-Client-Id": "ext.tstmst868.091dd0bd-ee4e-46db-b914-631c9a2d99cb@ext.vtb.ru",
            "Merchant-Authorization": "YYIK4l4jgus9hSKlKO7XTxau6ttPRusx",
            "Authorization": `Bearer ${data.access_token}`, // Replace with real token
            "Content-Type": "application/json"
        };

        const payload = {
            orderId,
            orderName,
            expire,
            amount,
            returnUrl
        };

        const response = await axios.post(
            "https://hackaton.bankingapi.ru/api/smb/efcp/e-commerce/api/v1/orders",
            payload,
            { headers }
        );

        res.json(response.data);
    } catch (error) {
        console.error("VTB Order Creation Error:", error.response?.data || error.message);
        res.status(500).json({ error: "Failed to create VTB order" });
    }
});


app.post('/check_pay', async (req, res) => {
    try {
        const { orderId } = req.body;

        if (!orderId) {
            return res.status(400).json({ error: "Missing required 'orderId'" });
        }

        // Generate access token from VTB
        const data = await generationBankToken();

        const headers = {
            "X-IBM-Client-Id": "ext.tstmst868.091dd0bd-ee4e-46db-b914-631c9a2d99cb@ext.vtb.ru",
            "Merchant-Authorization": "YYIK4l4jgus9hSKlKO7XTxau6ttPRusx",
            "Authorization": `Bearer ${data.access_token}`,
            "Content-Type": "application/json"
        };

        const response = await axios.get(
            `https://hackaton.bankingapi.ru/api/smb/efcp/e-commerce/api/v1/orders/${orderId}`,
            { headers }
        );

        const payment = response?.data?.object;

        if (payment) {
            const pay_status = payment.status.value;
            const transaction_id = payment.orderId;
            const transaction_code = payment.orderCode;
            const clean_order_id = transaction_id.replace("ORDER", "");

            // Optional: validate DB order exists before updating
            try{
                await db.query(
                    'UPDATE orders SET pay_status = ?, transaction_id = ?, transaction_code = ? WHERE order_id = ?',
                    [pay_status, transaction_id, transaction_code, clean_order_id]
                );
            }catch (e){
                console.log('safsa',e);
            }


            return res.json({ message: 'Order status updated', status: pay_status });
        } else {
            return res.status(404).json({ error: "No payment info found for this order" });
        }
    } catch (error) {
        console.error("VTB Order Status Error:", error.response?.data || error.message);
        return res.status(500).json({ error: "Failed to check payment status" });
    }
});


const generationBankToken = async ()=>{
    try {
        const params = new URLSearchParams();
        params.append("grant_type", "client_credentials");
        params.append("client_id", "ext.tstmst868.091dd0bd-ee4e-46db-b914-631c9a2d99cb@ext.vtb.ru");
        params.append("client_secret", "YYIK4l4jgus9hSKlKO7XTxau6ttPRusx");

        const response = await axios.post(
            "https://auth.bankingapi.ru/auth/realms/kubernetes/protocol/openid-connect/token",
            params,
            {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded"
                }
            }
        );
        return response.data
    } catch (error) {
        return error
    }
}


app.post('/create-package', async (req, res) => {
    try {
        const payload = req.body;

        const headers = {
            "accept": "application/vnd.leveltravel.v3.7",
            "authorization": 'Token token="6a6ca82f341fea2a9d19b0d581c448e7"',
            "Content-Type": "application/json",
            "Cookie": "uuid=e5ceff57-c62e-429a-b3c1-8da68bd9d447"
        };

        let params = {
            client: {
                id: "3003047",
                name: "Туртест",
                surname: "Арлекино",
                email: "arlekinotour_test@level.travel",
                phone: "7972988888"
            },
            package_id:payload?.package_id,
            tourists:payload?.tourists,
            flight_pair_id:payload.flight_pair_id,
            payment_option: "card",
            selected_extras:[],
            source:'desktop',
            comment: "yafob30749@lhory.com;7920998299;Дмитрий;Васильков"
        }

        console.log('params',params)

        const response = await axios.post(`${BASE_URL}/orders/create`, params,
            { headers }
        );
        if(response.data.success){
            let order_id = response.data.order.id;
            let package = JSON.stringify(response.data.order);
            let user_id = payload.user_id;
            await db.query(
                'INSERT INTO orders (order_id, package, user_id) VALUES (?, ?, ?)',
                [order_id, package, user_id]
            );
        }

        res.json(response.data);
    } catch (error) {
        res.json({error:error.response?.data || error.message});

    }
});

app.post('/validate-tourists', async (req, res) => {
    try {
        const response = await axios.post(`${BASE_URL}/tourists/validate`, req.body, {
            headers: HEADERS,
        });

        res.json(response.data);
    } catch (error) {
        console.error("Error validating tourists:", error);
        res.json({valid: false, errors: null});
    }
});

app.get('/orders', async (req, res) => {
    try {
        const [orders] = await db.query('SELECT * FROM orders WHERE order_id = ?', [req.query.order_id]);
        let order =JSON.parse(orders[0]['package']);

        res.json({...orders[0],package:order});
    } catch (error) {
        console.error('Error departures:', error.message);
        res.status(500).json({ error: 'Failed departures' });
    }
});
app.get('/user/orders', async (req, res) => {
    try {
        const [orders] = await db.query('SELECT * FROM orders WHERE user_id = ?', [req.query.user_id]);
        const parsedOrders = orders.map(order => {
            let parsedPackage;

            try {
                parsedPackage = JSON.parse(order.package);
            } catch (e) {
                parsedPackage = {}; // or null / order.package if invalid JSON
            }

            return {
                ...order,
                package: parsedPackage
            };
        });

        res.json(parsedOrders);
    } catch (error) {
        console.error('Error departures:', error.message);
        res.status(500).json({ error: 'Failed departures' });
    }
});

app.use('/api/auth', authRoutes);
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/admin', faqRoutes);
app.use('/api/admin', popularRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/admin/pages', pagesRoutes);
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
    console.log(`Level Travel proxy API running on port ${PORT}`);
});
