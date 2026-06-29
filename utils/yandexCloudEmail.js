const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');

const POSTBOX_ENDPOINT = 'https://postbox.cloud.yandex.net';
const POSTBOX_REGION = 'ru-central1';
const CHARSET = 'UTF-8';

let client;

function getClient() {
    if (client) return client;

    const accessKeyId = process.env.YC_POSTBOX_ACCESS_KEY_ID;
    const secretAccessKey = process.env.YC_POSTBOX_SECRET_ACCESS_KEY;

    if (!accessKeyId || !secretAccessKey) {
        throw new Error('YC_POSTBOX_ACCESS_KEY_ID and YC_POSTBOX_SECRET_ACCESS_KEY must be set');
    }

    client = new SESv2Client({
        region: POSTBOX_REGION,
        endpoint: POSTBOX_ENDPOINT,
        credentials: { accessKeyId, secretAccessKey },
    });

    return client;
}

function getFromAddress() {
    const from = process.env.EMAIL_FROM || process.env.EMAIL_USER;
    if (!from) {
        throw new Error('EMAIL_FROM or EMAIL_USER must be set');
    }
    return from;
}

async function sendEmail({ to, subject, text, html }) {
    const recipients = Array.isArray(to) ? to : [to];
    const body = {};

    if (text) {
        body.Text = { Charset: CHARSET, Data: text };
    }
    if (html) {
        body.Html = { Charset: CHARSET, Data: html };
    }
    if (!body.Text && !body.Html) {
        throw new Error('Either text or html body is required');
    }

    const command = new SendEmailCommand({
        FromEmailAddress: getFromAddress(),
        Destination: { ToAddresses: recipients },
        Content: {
            Simple: {
                Subject: { Charset: CHARSET, Data: subject },
                Body: body,
            },
        },
    });

    return getClient().send(command);
}

module.exports = { sendEmail };
