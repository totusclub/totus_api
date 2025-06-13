const crypto = require('crypto');
const axios = require('axios');

const username = 'arlekino_1_570706';
const rawPassword = 'Wajklfnknsdjkni9809u92';

// Step 1: Generate a random nonce and convert it to base64
const nonceRaw = crypto.randomBytes(16);
const nonceBase64 = nonceRaw.toString('base64');

// Step 2: Get the current time in ISO format
const created = new Date().toISOString();

// Step 3: Hash the password using MD5
const md5Password = crypto.createHash('md5').update(rawPassword).digest('hex');

// Step 4: Create the SHA1 digest (nonce + created + md5 password)
const sha1 = crypto.createHash('sha1');
sha1.update(Buffer.concat([
    nonceRaw,
    Buffer.from(created, 'utf8'),
    Buffer.from(md5Password, 'utf8')
]));
const passwordHash = sha1.digest('base64');

// Step 5: Send the login request
const url = 'http://search.samo.ru/api/';
const loginParams = new URLSearchParams({
    action: 'login',
    username,
    password: passwordHash,
    nonce: nonceBase64,
    created
});

axios.get(`${url}?${loginParams.toString()}`)
    .then(res => {
        const sid = res.data.sid;
        console.log('✅ Logged in. SID:', sid);

        if (!sid) {
            throw new Error('SID not returned in login response');
        }

        // const searchParams = new URLSearchParams({
        //     action: 'townfrom',
        //     sid,
        //     name: 'москва'
        // });
        // const searchParamsState = new URLSearchParams({
        //     action: 'state',
        //     sid,
        //     TOWNFROMINC: 5
        // });
        const priceParams = new URLSearchParams({
            version: '1.01',
            action: 'price',
            sid,
            // PAGE: '1',
            TOWNFROMINC: '2',
            // STATEINC: '3',
            // NIGHTS_FROM: '7',
            // NIGHTS_TILL: '10',
            ADULT: '1',
            CHILD: '2',
            // AGES: '4,8',
            // CURRENCYINC: '2',
            // COSTMIN: '1000',
            // COSTMAX: '1250',
            // CHECKIN_BEG: '20250718',
            // CHECKIN_END: '20250725',
            // HOTELS: '2000061932,2000065683,2000040679,2000072638',
            // FREIGHT: '1',
            // STOPSALE: '1',
            // MEAL: '2,4,6'
        });

        return axios.get(`${url}?${priceParams.toString()}`);



    })
    .then(searchRes => {
        console.log('🔍 Search Results:', searchRes.data);
    })
    .catch(err => {
        console.error('❌ Error:', err.message);
        if (err.response) {
            console.error('Response data:', err.response.data);
        }
    });
