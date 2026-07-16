require('dotenv').config();
require('dotenv').config({ path: '.env.local', override: true });
const express = require('express');
const https = require('https');
const axios = require('axios');

const vtbHttpsAgent = new https.Agent({ rejectUnauthorized: false });
const vtbAxiosConfig = { httpsAgent: vtbHttpsAgent };
const cors = require('cors');
const authRoutes = require('./routes/auth.routes');
const adminAuthRoutes = require('./routes/authRoutes');
const faqRoutes = require('./routes/faq.routes');
const popularRoutes = require('./routes/popular.routes');
const contentRoutes = require('./routes/content.routes');
const pagesRoutes = require('./routes/pages.routes');
const { router: callbackRequestsRoutes, adminRouter: callbackRequestsAdminRoutes } = require('./routes/callbackRequests.routes');
const { publicRouter: homeBannersPublicRoutes, adminRouter: homeBannersAdminRoutes } = require('./routes/homeBanners.routes');
const { publicRouter: homePartnersPublicRoutes, adminRouter: homePartnersAdminRoutes } = require('./routes/homePartners.routes');
const { publicRouter: homeHeroPublicRoutes, adminRouter: homeHeroAdminRoutes } = require('./routes/homeHero.routes');
const { publicRouter: homeContentPublicRoutes, adminRouter: homeContentAdminRoutes } = require('./routes/homeContent.routes');
const { publicRouter: footerSocialPublicRoutes, adminRouter: footerSocialAdminRoutes } = require('./routes/footerSocial.routes');
const homeContentController = require('./controllers/homeContent.controller');
const emailRoutes = require('./routes/email.routes');
const db = require("./db");
const crypto = require('crypto');
const path = require('path');
const {json, response} = require("express");

const app = express();
app.use(cors());
app.use(express.json());

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/upload/content', express.static(path.join(__dirname, 'upload/content')));
app.use('/upload/home', express.static(path.join(__dirname, 'upload/home')));

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
const LT_API_TOKEN = process.env.LT_API_TOKEN || process.env.LT_PARTNER_API_KEY || '6a6ca82f341fea2a9d19b0d581c448e7';
const HEADERS_3_4 = {
    Accept: 'application/vnd.leveltravel.v3.4',
    Authorization: `Token token="${LT_API_TOKEN}"`,
    'Content-Type': 'application/json',
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

app.get('/references/hotel_reviews/:hotel_id', async (req, res) => {
    try {
        const { hotel_id } = req.params;
        const { page, per_page } = req.query;
        const response = await axios.get(`${BASE_URL}/references/hotel_reviews/${hotel_id}`, {
            params: { page, per_page },
            headers: HEADERS,
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error hotel_reviews:', error.message);
        const status = error.response?.status || 500;
        const data = error.response?.data || { success: false, error: 'Failed hotel_reviews' };
        res.status(status).json(data);
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

app.post('/orders/prebuild', async (req, res) => {
    try {
        const response = await axios.post(`${BASE_URL}/orders/prebuild`, req.body, {
            headers: HEADERS,
        });
        res.json(response.data);
    } catch (error) {
        console.error('Order prebuild error:', error.response?.data || error.message);
        res.status(error.response?.status || 500).json({
            success: false,
            error: error.response?.data || error.message,
        });
    }
});

app.post('/packages/prebook', async (req, res) => {
    try {
        // Docs require accept v3.8; some partner tokens only expose older Accepts.
        // Try 3.8 then fall back to project default (3.7).
        let response;
        try {
            response = await axios.post(`${BASE_URL}/packages/prebook`, req.body, {
                headers: HEADERS_3_8,
            });
        } catch (firstError) {
            const firstMsg =
                firstError.response?.data?.error ||
                firstError.response?.data?.message ||
                '';
            const isVersionError =
                String(firstMsg).toLowerCase().includes('incorrect api version') ||
                String(firstMsg).toLowerCase().includes('api version');

            if (!isVersionError) {
                throw firstError;
            }

            console.warn('Package prebook v3.8 rejected, retrying with v3.7:', firstMsg);
            response = await axios.post(`${BASE_URL}/packages/prebook`, req.body, {
                headers: HEADERS,
            });
        }

        res.json(response.data);
    } catch (error) {
        console.error('Package prebook error:', error.response?.data || error.message);
        const ltError = error.response?.data;
        res.status(error.response?.status || 500).json({
            success: false,
            error: ltError?.error || ltError || error.message,
            errors: ltError?.errors || [],
            skippable:
                String(ltError?.error || '')
                    .toLowerCase()
                    .includes('incorrect api version') ||
                String(ltError?.error || '')
                    .toLowerCase()
                    .includes('api version'),
        });
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
            sort_by,
            filter_beach_surface
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
            ...(filter_beach_surface && { filter_beach_surface }),
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
            hotel_id,
            meals,
            confirmability,
            free_cancel,
            operators,
        } = req.query;

        if (!request_id) {
            return res.status(400).json({ error: 'Missing request_id' });
        }

        const params = {
            request_id,
            hotel_id,
            ...(meals && { meals }),
            ...(confirmability && { confirmability }),
            ...(free_cancel !== undefined && free_cancel !== '' && { free_cancel }),
            ...(operators && { operators }),
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
            returnUrl,
            paymentPurpose,
            purposeText,
        } = req.body;

        if (!orderId || !orderName || !expire || !amount?.value || !amount?.code || !returnUrl) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const { createVtbPaymentForOrder } = require("./utils/vtbCreatePayment");
        const result = await createVtbPaymentForOrder({
            orderId,
            orderName,
            amount,
            paymentPurpose: paymentPurpose || purposeText,
            paymentMinutes: 30,
            sendEmail: true,
        });

        res.json(result);
    } catch (error) {
        console.error("VTB Order Creation Error:", error.response?.data || error.message);
        res.status(500).json({ error: "Failed to create VTB order", details: error.message });
    }
});



const generationBankToken = async ()=>{
    try {
        const params = new URLSearchParams();
        params.append("grant_type", "client_credentials");
        params.append("client_id", "wb1a7e7gwrhrvr3.b4b1b7e2-10a2-4e00-af7f-f0337c1b618c@ext.vtb.ru");
        params.append("client_secret", "XMB2l-jkg2RO20(U");
        const response = await axios.post(
            "https://open.api.vtb.ru:443/passport/oauth2/token",
            params,
            vtbAxiosConfig
        );
        console.log("VTB Token Response:-----", response.data);
        return response.data
    } catch (error) {
        console.log("VTB Token Error:", error.message);
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

        const buyerEmail =
            payload?.client?.email ||
            payload?.email ||
            null;
        const buyerPhoneDigits = String(
            payload?.client?.phone ||
            payload?.phone ||
            '',
        ).replace(/\D/g, '');
        const buyerName = payload?.client?.name || '';
        const buyerSurname = payload?.client?.surname || '';
        const buyerComment =
            payload?.comment ||
            [buyerEmail, buyerPhoneDigits, buyerName, buyerSurname].filter(Boolean).join(';');

        let params = {
            client: {
                name: buyerName || 'Покупатель',
                surname: buyerSurname || '',
                email: buyerEmail,
                phone: buyerPhoneDigits,
                bonus_score: payload?.client?.bonus_score ?? 0,
                ...(payload?.client?.id ? { id: payload.client.id } : {}),
            },
            package_id: payload?.package_id,
            tourists: payload?.tourists,
            flight_pair_id: payload.flight_pair_id,
            payment_option: payload?.payment_option || 'card',
            selected_extras: payload?.selected_extras || [],
            source: 'desktop',
            comment: buyerComment,
            ...(payload?.booking_id ? { booking_id: payload.booking_id } : {}),
        };

        if (!params.client.email || !params.client.phone) {
            return res.status(400).json({
                success: false,
                error: 'Buyer email and phone are required',
            });
        }

        console.log('params', params);

        const response = await axios.post(`${BASE_URL}/orders/create`, params,
            { headers }
        );
        if(response.data.success){
            let order_id = response.data.order.id;
            const { normalizeOrderPayFields, resolveLtOrderPayAmount } = require('./utils/orderPayment');
            let orderData = normalizeOrderPayFields({ ...response.data.order });
            const authToken =
                String(
                    response.data.order?.auth_token ||
                    response.data.auth_token ||
                    response.data.order?.client?.auth_token ||
                    payload.auth_token ||
                    '',
                ).trim() || null;
            if (authToken) {
                orderData._lt_auth_token = authToken;
                orderData.auth_token = authToken;
            }

            const customerEmail =
                payload?.email ||
                payload?.client?.email ||
                payload?.tourists?.find?.((item) => item?.email)?.email ||
                params.client?.email ||
                null;
            const customerPhone =
                payload?.phone ||
                payload?.client?.phone ||
                params.client?.phone ||
                null;
            const customerName =
                payload?.name ||
                [payload?.client?.name, payload?.client?.surname].filter(Boolean).join(' ').trim() ||
                null;

            if (customerEmail) {
                orderData._customer_email = customerEmail;
            }
            if (customerPhone) {
                orderData._customer_phone = String(customerPhone).replace(/\D/g, '');
            }
            if (customerName) {
                orderData._customer_name = customerName;
            }

            // Keep buyer client block for checkout display
            orderData.client = {
                ...(orderData.client || {}),
                ...(payload?.client || {}),
                email: customerEmail || orderData.client?.email || params.client?.email,
                phone: customerPhone || orderData.client?.phone || params.client?.phone,
                name: payload?.client?.name || orderData.client?.name || params.client?.name,
                surname: payload?.client?.surname || orderData.client?.surname || params.client?.surname,
            };

            let package = JSON.stringify(orderData);
            let user_id = payload.user_id;
            try {
                await db.query(
                    'INSERT INTO orders (order_id, package, user_id, lt_auth_token) VALUES (?, ?, ?, ?)',
                    [order_id, package, user_id, authToken]
                );
            } catch (dbErr) {
                await db.query(
                    'INSERT INTO orders (order_id, package, user_id) VALUES (?, ?, ?)',
                    [order_id, package, user_id]
                );
            }

            const paymentAmount =
                payload?.amount ||
                payload?.payment?.amount ||
                resolveLtOrderPayAmount(orderData) ||
                orderData?.full_price ||
                orderData?.price ||
                orderData?.total_price ||
                orderData?.amount ||
                null;

            if (payload?.payUrl) {
                try {
                    const { savePaymentToPackage } = require('./utils/orderPayment');
                    const { normalizeAmount } = require('./utils/vtbCreatePayment');
                    const normalizedAmount = normalizeAmount(paymentAmount);
                    await savePaymentToPackage(order_id, {
                        payUrl: payload.payUrl,
                        qrcId: payload?.qrcId || null,
                        amount: normalizedAmount?.value,
                        paymentMinutes: 30,
                    });

                    const [rows] = await db.query(
                        'SELECT * FROM orders WHERE order_id = ? LIMIT 1',
                        [order_id]
                    );
                    if (rows[0]) {
                        const { sendOrderCreatedEmail } = require('./utils/orderEmails');
                        sendOrderCreatedEmail(order_id, rows[0], {
                            payUrl: payload.payUrl,
                            amount: normalizedAmount?.value,
                            paymentMinutes: 30,
                        }).catch((err) => {
                            console.error('[ORDER_EMAIL] create-package payUrl:', err.message);
                        });
                    }
                } catch (emailErr) {
                    console.error('[ORDER_EMAIL] create-package payUrl lookup:', emailErr.message);
                }
            } else if (paymentAmount) {
                const { createVtbPaymentForOrder } = require('./utils/vtbCreatePayment');
                createVtbPaymentForOrder({
                    orderId: order_id,
                    orderName: payload?.orderName || `ORDER${order_id}`,
                    amount: paymentAmount,
                    paymentPurpose: payload?.paymentPurpose || payload?.purposeText,
                    paymentMinutes: 30,
                    sendEmail: true,
                }).catch((err) => {
                    console.error('[ORDER_EMAIL] create-package auto-payment:', err.message);
                });
            }
        }

        res.json(response.data);
    } catch (error) {
        res.json({error:error.response?.data || error.message});

    }
});

app.post('/validate-tourists', async (req, res) => {
    try {
        const response = await axios.post(
            `${BASE_URL}/tourists/validate`,
            req.body,
            { headers: HEADERS }
        );

        console.log('response.data:', response.data);

        return res.json(response.data);

    } catch (error) {
        console.error(
            'Validate tourists error:',
            error.response?.data || error.message
        );

        return res.status(error.response?.status || 500).json({
            success: false,
            error: error.response?.data || 'Validation failed'
        });
    }
});


// Level Travel client orders (proxy to api.level.travel)
app.get('/client/orders', async (req, res) => {
    try {
        const src = { ...req.query, ...req.body };
        const payload = {
            auth_token: src.auth_token,
            page_number: String(src.page_number ?? '0'),
            page_limit: String(src.page_limit ?? '10'),
        };

        if (!payload.auth_token) {
            return res.status(400).json({ error: 'Missing auth_token' });
        }

        const response = await axios({
            method: 'GET',
            url: `${BASE_URL}/client/orders`,
            headers: HEADERS_3_4,
            data: payload,
        });

        const { sanitizeLtApiPayloadForClient } = require('./utils/orderDocuments');
        const sanitized = await sanitizeLtApiPayloadForClient(null, response.data);
        return res.status(response.status).json(sanitized);
    } catch (error) {
        console.error('LT client orders list error:', error.response?.data || error.message);
        if (error.response) {
            return res.status(error.response.status).json(error.response.data);
        }
        return res.status(500).json({ error: error.message });
    }
});

app.get('/client/orders/:order_id', async (req, res) => {
    try {
        const src = { ...req.query, ...req.body };
        const auth_token = src.auth_token;
        const saveToDb = src.save !== '0' && src.save !== 'false';

        if (!auth_token) {
            return res.status(400).json({ error: 'Missing auth_token' });
        }

        const orderId = Number(req.params.order_id);
        const {
            fetchClientOrderRaw,
            buildPackageFromClientOrder,
            saveOrderPackageToDb,
            loadExistingPackage,
        } = require('./utils/levelTravelClientOrder');

        const { raw, order } = await fetchClientOrderRaw(req.params.order_id, auth_token);

        let package_updated = false;
        if (saveToDb && Number.isFinite(orderId)) {
            const existingPkg = await loadExistingPackage(orderId);
            const pkg = buildPackageFromClientOrder(
                order,
                raw,
                auth_token,
                [],
                existingPkg
            );
            package_updated = await saveOrderPackageToDb(
                orderId,
                pkg,
                auth_token,
                order.state
            );
        }

        const { sanitizeLtApiPayloadForClient } = require('./utils/orderDocuments');
        const sanitized = await sanitizeLtApiPayloadForClient(orderId, {
            ...raw,
            package_updated,
        });

        return res.status(200).json(sanitized);
    } catch (error) {
        console.error('LT client order by id error:', error.response?.data || error.message);
        if (error.response) {
            return res.status(error.response.status).json(error.response.data);
        }
        return res.status(500).json({ error: error.message });
    }
});

// Fetch LT order + save package to DB + download all PDFs
app.post('/client/orders/:order_id/sync', async (req, res) => {
    try {
        const orderId = Number(req.params.order_id);
        const auth_token =
            req.body?.auth_token || req.query?.auth_token || process.env.LT_CLIENT_AUTH_TOKEN;

        if (!Number.isFinite(orderId)) {
            return res.status(400).json({ error: 'Invalid order_id' });
        }
        if (!auth_token) {
            return res.status(400).json({ error: 'Missing auth_token' });
        }

        const { syncOrderFromClient } = require('./utils/levelTravelClientOrder');
        const { sanitizeLtApiPayloadForClient } = require('./utils/orderDocuments');
        const result = await syncOrderFromClient(orderId, auth_token, {
            downloadDocs: true,
            eventReference: `manual-sync-${Date.now()}`,
        });

        const sanitized = await sanitizeLtApiPayloadForClient(orderId, {
            ...result,
            lt_response: result.lt_response
                ? await sanitizeLtApiPayloadForClient(orderId, result.lt_response)
                : result.lt_response,
        });

        return res.status(200).json(sanitized);
    } catch (error) {
        console.error('LT client order sync error:', error.response?.data || error.message);
        if (error.response) {
            return res.status(error.response.status).json(error.response.data);
        }
        return res.status(500).json({ error: error.message });
    }
});

app.get('/orders', async (req, res) => {
    try {
        const orderId = String(req.query.order_id || '').replace(/^ORDER/i, '').trim();
        if (!orderId) {
            return res.status(400).json({ error: 'Missing order_id' });
        }

        const { attachPaymentToOrderResponse } = require('./utils/orderPayment');
        const { prepareOrderRowForClient } = require('./utils/orderDocuments');
        const {
            fetchClientOrderRaw,
            resolveAuthToken,
        } = require('./utils/levelTravelClientOrder');

        // Load DB row only for auth_token + local payment metadata (not as source of tour data)
        const [rows] = await db.query('SELECT * FROM orders WHERE order_id = ? LIMIT 1', [orderId]);
        const orderRow = rows[0] || null;

        let ltOrder = null;
        let ltSource = null;

        // 1) Prefer Level Travel partner order endpoint
        try {
            const partnerRes = await axios.get(`${BASE_URL}/orders/${orderId}`, {
                headers: HEADERS,
                timeout: 60000,
            });
            const data = partnerRes.data;
            ltOrder =
                data?.order ||
                (data?.success && data?.package ? data : null) ||
                (data?.id ? data : null);
            if (ltOrder) ltSource = 'partner_orders';
        } catch (partnerErr) {
            console.warn(
                'LT partner GET /orders/:id failed:',
                partnerErr.response?.data || partnerErr.message,
            );
        }

        // 2) Fallback: LT client/orders with auth_token
        if (!ltOrder) {
            const authToken = resolveAuthToken(orderRow, req.query.auth_token);
            if (authToken) {
                try {
                    const { order } = await fetchClientOrderRaw(orderId, authToken);
                    if (order) {
                        ltOrder = order;
                        ltSource = 'client_orders';
                    }
                } catch (clientErr) {
                    console.warn(
                        'LT client GET /client/orders/:id failed:',
                        clientErr.response?.data || clientErr.message,
                    );
                }
            }
        }

        if (ltOrder) {
            // Normalize shape expected by checkout: response.package = LT order
            const packagePayload = {
                ...ltOrder,
                // Ensure nested package exists when LT returns flat order
                package: ltOrder.package || ltOrder,
                _lt_source: ltSource,
            };

            const clientOrder = {
                order_id: orderId,
                package: packagePayload,
                pay_status: orderRow?.pay_status || null,
                transaction_code: orderRow?.transaction_code || null,
            };

            if (orderRow) {
                return res.json(attachPaymentToOrderResponse(orderRow, clientOrder));
            }
            return res.json(clientOrder);
        }

        // 3) Last resort: local DB snapshot (old orders / offline)
        if (!orderRow) {
            return res.status(404).json({ error: 'Order not found in Level Travel or DB' });
        }

        const order = await prepareOrderRowForClient(orderRow);
        res.json(attachPaymentToOrderResponse(orderRow, order));
    } catch (error) {
        console.error('Error orders:', error.message);
        res.status(500).json({ error: 'Failed to get order' });
    }
});

app.get('/orders/:order_id/payment', async (req, res) => {
    try {
        const { getOrderPayment } = require('./utils/orderPayment');
        const { createVtbPaymentForOrder, normalizeAmount } = require('./utils/vtbCreatePayment');

        let payment = await getOrderPayment(req.params.order_id);

        if (!payment) {
            return res.status(404).json({ error: 'Order not found' });
        }

        const shouldEnsure =
            req.query.ensure === '1' ||
            req.query.ensure === 'true' ||
            req.query.create === '1';

        if (shouldEnsure && !payment.paid && !payment.payUrl) {
            const [rows] = await db.query(
                'SELECT * FROM orders WHERE order_id = ? LIMIT 1',
                [String(req.params.order_id).replace(/^ORDER/i, '')]
            );
            const orderRow = rows[0];
            if (orderRow) {
                let pkg = {};
                try {
                    pkg = JSON.parse(orderRow.package || '{}');
                } catch {
                    pkg = {};
                }

                const amount =
                    normalizeAmount(req.query.amount) ||
                    normalizeAmount(pkg._pay_amount) ||
                    normalizeAmount(require('./utils/orderPayment').resolveLtOrderPayAmount(pkg)) ||
                    normalizeAmount(pkg.full_price) ||
                    normalizeAmount(pkg.price) ||
                    normalizeAmount(pkg.total_price) ||
                    normalizeAmount(pkg.amount);

                if (amount) {
                    await createVtbPaymentForOrder({
                        orderId: req.params.order_id,
                        orderName: req.query.orderName || `ORDER${req.params.order_id}`,
                        amount,
                        paymentPurpose: req.query.paymentPurpose,
                        paymentMinutes: 30,
                        sendEmail: false,
                    });
                    payment = await getOrderPayment(req.params.order_id);
                }
            }
        }

        res.json(payment);
    } catch (error) {
        console.error('Error order payment:', error.message);
        res.status(500).json({ error: 'Failed to get order payment' });
    }
});

app.get('/orders/documents', async (req, res) => {
    try {
        const orderId = Number(req.query.order_id);
        if (!Number.isFinite(orderId)) {
            return res.status(400).json({ error: 'Missing or invalid order_id' });
        }

        const { getOrderDocuments } = require('./utils/orderDocuments');
        const documents = await getOrderDocuments(orderId);
        res.json({ order_id: orderId, documents });
    } catch (error) {
        console.error('Error order documents:', error.message);
        res.status(500).json({ error: 'Failed to get order documents' });
    }
});
app.get('/user/orders', async (req, res) => {
    try {
        const [orders] = await db.query('SELECT * FROM orders WHERE user_id = ?', [req.query.user_id]);
        const { prepareOrderRowForClient } = require('./utils/orderDocuments');
        const parsedOrders = await Promise.all(
            orders.map((order) => prepareOrderRowForClient(order))
        );

        res.json(parsedOrders);
    } catch (error) {
        console.error('Error departures:', error.message);
        res.status(500).json({ error: 'Failed departures' });
    }
});


app.get('/home/data', homeContentController.getHomeData);

function isVtbSbpPaid(info) {
    const state = String(info?.state || info?.data?.state || "").toUpperCase();
    if (state === "ACWP" || state === "OK") return true;
    const statusVal = info?.status?.value || info?.data?.status?.value;
    return statusVal === "RECONCILED";
}

function resolveVtbPayStatus(info) {
    if (isVtbSbpPaid(info)) return "RECONCILED";
    const state = info?.state || info?.data?.state;
    if (state) return String(state).toUpperCase();
    const statusVal = info?.status?.value || info?.data?.status?.value;
    return statusVal || "PENDING";
}

app.post('/check_pay', async (req, res) => {
    try {
        let { qrcId, orderId } = req.body;
        const clean_order_id = orderId
            ? String(orderId).replace(/^ORDER/i, "")
            : null;

        if (!qrcId && clean_order_id) {
            const [rows] = await db.query(
                "SELECT pay_status, transaction_code FROM orders WHERE order_id = ? LIMIT 1",
                [clean_order_id]
            );
            const existing = rows[0];
            if (existing?.pay_status === "RECONCILED") {
                return res.status(200).json({
                    message: "Order already paid",
                    status: "RECONCILED",
                    paid: true,
                    order_id: clean_order_id,
                    notify_status: null,
                    notify_result: null,
                    notify_data: null,
                    notify_error: null,
                });
            }
            if (existing?.transaction_code) {
                qrcId = existing.transaction_code;
            }
        }

        if (!qrcId) {
            return res.status(200).json({
                status: "error",
                message: "Missing required 'qrcId' (or orderId with saved QR)",
                notify_status: null,
                notify_result: null,
                notify_data: null,
                notify_error: null,
            });
        }

        const tokenData = await generationBankToken();
        if (!tokenData?.access_token) {
            return res.status(200).json({
                status: "error",
                message: "Failed to obtain VTB access token",
                notify_status: null,
                notify_result: null,
                notify_data: null,
                notify_error: null,
            });
        }

        const headers = {
            "X-IBM-Client-Id": "wb1a7e7gwrhrvr3.b4b1b7e2-10a2-4e00-af7f-f0337c1b618c@ext.vtb.ru",
            "Merchant-Authorization": "93f69779-51bd-4787-acd7-c8573cdbdc9c",
            "Authorization": `Bearer ${tokenData.access_token}`,
            "Content-Type": "application/json",
        };

        const vtbResponse = await axios.post(
            "https://gw.api.vtb.ru/openapi/smb/efcp/sbp-gateway/v1/qr/dynamics/info",
            { qrcId },
            { headers, ...vtbAxiosConfig }
        );

        const payment = vtbResponse?.data?.data || vtbResponse?.data;
        if (!payment) {
            return res.status(200).json({
                status: "not_found",
                message: "No payment info found",
                notify_status: null,
                notify_result: null,
                notify_data: null,
                notify_error: null,
            });
        }

        const pay_status = resolveVtbPayStatus(payment);
        const paid = pay_status === "RECONCILED";
        const requestId = payment.requestId || payment.orderId;
        const resolved_order_id = clean_order_id || String(requestId || "").replace(/^ORDER/i, "");
        const transaction_id = payment.transactionId || requestId;
        const transaction_code = payment.orderCode || qrcId;
        const amount = payment?.amount?.value ?? payment?.amount;

        let notify_status = null;
        let notify_result = null;
        let notify_data = null;
        let notify_error = null;

        let alreadyNotified = false;
        if (resolved_order_id) {
            const [rows] = await db.query(
                "SELECT pay_status FROM orders WHERE order_id = ? LIMIT 1",
                [resolved_order_id]
            );
            alreadyNotified = rows[0]?.pay_status === "RECONCILED";
        }

        if (paid && resolved_order_id && !alreadyNotified) {
            try {
                const ltStatus = "paid";
                const signature = generateSignature(
                    resolved_order_id,
                    ltStatus,
                    amount,
                    "6a6ca82f341fea2a9d19b0d581c448e7"
                );

                const notifyResponse = await axios.post(
                    `${BASE_URL}/orders/${resolved_order_id}/notify`,
                    {
                        order_id: resolved_order_id,
                        status: ltStatus,
                        amount,
                        signature,
                    },
                    { headers: HEADERS }
                );

                notify_status = notifyResponse.status;
                notify_result = "ok";
                notify_data = notifyResponse.data;
            } catch (notifyErr) {
                notify_status = notifyErr.response?.status || 500;
                notify_result = "error";
                notify_error = notifyErr.response?.data || notifyErr.message;
            }
        }

        if (resolved_order_id) {
            try {
                await db.query(
                    "UPDATE orders SET pay_status = ?, transaction_id = ?, transaction_code = ? WHERE order_id = ?",
                    [pay_status, transaction_id, transaction_code, resolved_order_id]
                );
            } catch (dbErr) {
                console.error("DB update failed:", dbErr);
            }

            if (paid && !alreadyNotified) {
                try {
                    const [rows] = await db.query(
                        "SELECT * FROM orders WHERE order_id = ? LIMIT 1",
                        [resolved_order_id]
                    );
                    if (rows[0]) {
                        const { sendOrderPaidPendingEmail } = require("./utils/orderEmails");
                        sendOrderPaidPendingEmail(resolved_order_id, rows[0], { amount }).catch((err) => {
                            console.error("[ORDER_EMAIL] check_pay:", err.message);
                        });
                    }
                } catch (emailErr) {
                    console.error("[ORDER_EMAIL] check_pay lookup:", emailErr.message);
                }
            }
        }

        return res.status(200).json({
            message: "Order status checked",
            status: pay_status,
            paid,
            qrcId,
            order_id: resolved_order_id,
            transaction_id,
            transaction_code,
            notify_status,
            notify_result,
            notify_data,
            notify_error,
        });
    } catch (err) {
        console.error("VTB check_pay error:", err.response?.data || err.message);

        return res.status(200).json({
            status: "error",
            message: "Failed to check payment status",
            notify_status: null,
            notify_result: null,
            notify_data: err.response?.data || null,
            notify_error: err.response?.data?.message || err.message,
            vtb_status: err.response?.status || null,
        });
    }
});




app.post('/payment/status', async (req, res) => {
    try {
        const payload = req.body;

        const signature = generateSignature(
            payload.order_id,
            payload.status,
            payload.amount,
            "6a6ca82f341fea2a9d19b0d581c448e7"
        );


        const signatureCancelled = generateSignatureCancelled(
            payload.order_id,
            payload.status,
            payload.amount,
            "6a6ca82f341fea2a9d19b0d581c448e7"
        );

        const object = {
            order_id: payload.order_id,
            // status: payload.status,
            signature: signatureCancelled,
            amount: payload.amount,
        };

        const response = await axios.post(
            `${BASE_URL}/orders/${payload.order_id}/notify`,
            object,
            { headers: HEADERS }
        );

        // Return same response (status + data)
        return res.status(response.status).json(response.data);

    } catch (error) {
        console.log('Axios Error:', error.response?.data || error.message);

        // Return backend error EXACTLY
        if (error.response) {
            return res
                .status(error.response.status)
                .json(error.response.data);
        }

        return res.status(500).json({ error: error.message });
    }
});

const sha256 = (data) => {
    return crypto.createHash('sha256').update(String(data)).digest('hex');
}

function generateSignature(order_id, status, amount, partner_api_key) {
    return sha256((sha256(order_id)+sha256(status)+sha256(amount)+sha256(partner_api_key)));
}

function generateSignatureCancelled(order_id, status, partner_api_key) {
    return sha256((sha256(order_id)+sha256(status)+sha256(partner_api_key)));
}

const {
    verifyPartnerApiKey,
    logLtRequest,
    processOrderNotify,
    processOrderRefund,
} = require('./utils/levelTravelWebhooks');
const { processVtbCallback } = require('./utils/vtbCallback');

const { logCallback, logCallbackError } = require('./utils/callbackLogger');

// VTB SBP: final payment/refund status callback from bank
app.post('/vtb/callback', async (req, res) => {
    try {
        const result = await processVtbCallback(req.body);
        return res.status(200).json(result);
    } catch (error) {
        logCallbackError('VTB_CALLBACK', 'HTTP_ERROR', error.message, req.body);
        const status = error.status || 500;
        return res.status(status).json({
            success: false,
            error: error.message,
        });
    }
});

// Partner → Level Travel: notify order paid
app.post('/level_travel/notify-paid', async (req, res) => {
    try {
        const { order_id, amount } = req.body;
        if (!order_id) {
            return res.status(400).json({ success: false, error: "Missing order_id" });
        }

        const { notifyLevelTravelOrderPaid } = require('./utils/levelTravelPayment');
        const result = await notifyLevelTravelOrderPaid({ order_id, amount });
        return res.status(200).json(result);
    } catch (error) {
        logCallbackError('LT_PAY_NOTIFY', 'HTTP_ERROR', error.message, {
            order_id: req.body?.order_id,
            lt_error: error.lt_error,
        });
        const status = error.status || 500;
        return res.status(status).json({
            success: false,
            error: error.message,
            lt_error: error.lt_error || null,
        });
    }
});

// Level Travel → partner: order change notifications
app.post('/tours/level_travel/notify', logLtRequest('LT_NOTIFY'), verifyPartnerApiKey, async (req, res) => {
    try {
        const result = await processOrderNotify(req.body);
        return res.status(200).json(result);
    } catch (error) {
        logCallbackError('LT_NOTIFY', 'HTTP_ERROR', error.message, req.body);
        const status = error.status || 500;
        return res.status(status).json({
            success: false,
            error: error.message,
        });
    }
});

// Level Travel → partner: refund notification
app.post('/tours/level_travel/order_refund', logLtRequest('LT_REFUND'), verifyPartnerApiKey, async (req, res) => {
    try {
        const result = await processOrderRefund(req.body);
        return res.status(200).json(result);
    } catch (error) {
        logCallbackError('LT_REFUND', 'HTTP_ERROR', error.message, req.body);
        const status = error.status || 500;
        return res.status(status).json({
            success: false,
            error: error.message,
        });
    }
});

// Level Travel callback history (saved in lt_order_events)
app.get('/tours/level_travel/history', verifyPartnerApiKey, async (req, res) => {
    try {
        const { getAllLtCallbackHistory } = require('./utils/clientOrders');
        const data = await getAllLtCallbackHistory({
            order_id: req.query.order_id,
            limit: req.query.limit,
            offset: req.query.offset,
        });
        return res.status(200).json(data);
    } catch (error) {
        logCallbackError('LT_HISTORY', 'ERROR', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});

app.use('/api/auth', authRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/admin', faqRoutes);
app.use('/api/admin', popularRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/pages', require('./routes/publicPages.routes'));
app.use('/api/admin/pages', pagesRoutes);
app.use('/api/callback-requests', callbackRequestsRoutes);
app.use('/api/admin', callbackRequestsAdminRoutes);
app.use('/api', homeBannersPublicRoutes);
app.use('/api/admin', homeBannersAdminRoutes);
app.use('/api', homePartnersPublicRoutes);
app.use('/api/admin', homePartnersAdminRoutes);
app.use('/api', homeHeroPublicRoutes);
app.use('/api/admin', homeHeroAdminRoutes);
app.use('/api', homeContentPublicRoutes);
app.use('/api/admin', homeContentAdminRoutes);
app.use('/api', footerSocialPublicRoutes);
app.use('/api/admin', footerSocialAdminRoutes);
app.use('/api', require('./routes/publicFaq.routes'));
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Level Travel proxy API running on port ${PORT}`);
    console.log(`[CALLBACKS] VTB bank:     POST /vtb/callback`);
    console.log(`[CALLBACKS] To Level Travel: POST /level_travel/notify-paid`);
    console.log(`[CALLBACKS] Level Travel: POST /tours/level_travel/notify`);
    console.log(`[CALLBACKS] Level Travel: POST /tours/level_travel/order_refund`);
    console.log(`[CALLBACKS] Level Travel: GET  /tours/level_travel/history`);
    console.log(`[CALLBACKS] PARTNER_API_KEY loaded: ${Boolean(process.env.PARTNER_API_KEY)}`);
});
