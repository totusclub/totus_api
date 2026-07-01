const { sendEmail } = require('../utils/yandexCloudEmail');
const { welcomeTotusClubTemplate, verificationCodeTemplate } = require('../utils/emailTemplates');
const {
    orderCreatedTemplate,
    orderPaidPendingTemplate,
    orderConfirmedTemplate,
    orderDocumentsTemplate,
    orderCancelledTemplate,
} = require('../utils/orderEmailTemplates');

const TEMPLATE_META = {
    welcome: {
        label: 'Приветственное письмо',
        description: 'Welcome to Totus Club',
    },
    verification: {
        label: 'Код подтверждения',
        description: 'Signup / signin verification code',
    },
    order_created: {
        label: 'Заказ создан',
        description: 'Order created with 15 min SBP payment',
    },
    order_paid_pending: {
        label: 'Оплата получена',
        description: 'Payment received, waiting for booking confirmation',
    },
    order_confirmed: {
        label: 'Бронирование подтверждено',
        description: 'Totus Club confirmed booking',
    },
    order_documents: {
        label: 'Документы готовы',
        description: 'Travel documents with download links',
    },
    order_cancelled: {
        label: 'Заказ отменён',
        description: 'Order cancellation notice',
    },
};

function buildTemplate(template, options = {}) {
    const {
        name,
        code = '4829',
        orderId = 12345,
        details = 'Отель Rixos, 7 ночей, 2 взрослых',
        reason = 'Туроператор отменил бронирование',
        payUrl = 'https://qr.nspk.ru/sample-payment-link',
        amount = 125000,
        paymentMinutes = 15,
        documents = [
            {
                title: 'Договор.pdf',
                url: 'https://api.totus.club/uploads/orders/12345/sample-contract.pdf',
            },
            {
                title: 'Ваучер.pdf',
                url: 'https://api.totus.club/uploads/orders/12345/sample-voucher.pdf',
            },
        ],
    } = options;

    switch (template) {
        case 'welcome':
            return welcomeTotusClubTemplate({ name });
        case 'verification':
            return verificationCodeTemplate(code, { name });
        case 'order_created':
            return orderCreatedTemplate({ name, orderId, details, payUrl, amount, paymentMinutes });
        case 'order_paid_pending':
            return orderPaidPendingTemplate({ name, orderId, details, amount });
        case 'order_confirmed':
            return orderConfirmedTemplate({ name, orderId, details });
        case 'order_documents':
            return orderDocumentsTemplate({ name, orderId, details, documents });
        case 'order_cancelled':
            return orderCancelledTemplate({ name, orderId, details, reason });
        default:
            return null;
    }
}

exports.listTestTemplates = (req, res) => {
    res.status(200).json({
        templates: Object.entries(TEMPLATE_META).map(([key, meta]) => ({
            key,
            ...meta,
        })),
        send_one: 'POST /api/email/test/send  { "to": "...", "template": "welcome" }',
        send_all: 'POST /api/email/test/all  { "to": "..." }',
    });
};

exports.sendTestEmail = async (req, res) => {
    req.body = { ...req.body, template: req.body.template || 'welcome' };
    return exports.sendTestTemplate(req, res);
};

exports.sendTestTemplate = async (req, res) => {
    const {
        to,
        template,
        name,
        subject,
        text,
        html,
        code,
        orderId,
        details,
        reason,
        documents,
    } = req.body;

    if (!to) {
        return res.status(400).json({ message: 'Укажите email получателя (to)' });
    }

    if (!template) {
        return res.status(400).json({
            message: 'Укажите шаблон (template)',
            available: Object.keys(TEMPLATE_META),
        });
    }

    if (!TEMPLATE_META[template]) {
        return res.status(400).json({
            message: 'Неизвестный шаблон',
            available: Object.keys(TEMPLATE_META),
        });
    }

    const from = process.env.EMAIL_FROM || process.env.EMAIL_USER;
    const built = buildTemplate(template, {
        name,
        code,
        orderId,
        details,
        reason,
        documents,
    });

    if (!built) {
        return res.status(400).json({ message: 'Не удалось собрать шаблон' });
    }

    try {
        const result = await sendEmail({
            to,
            subject: subject || built.subject,
            text: text || built.text,
            html: html || built.html,
        });

        res.status(200).json({
            message: 'Тестовое письмо отправлено',
            template,
            from,
            to,
            messageId: result.MessageId,
        });
    } catch (err) {
        res.status(500).json({
            message: 'Не удалось отправить тестовое письмо',
            template,
            error: err.message,
        });
    }
};

exports.sendAllTestTemplates = async (req, res) => {
    const { to, name, orderId, details, code, reason, documents } = req.body;

    if (!to) {
        return res.status(400).json({ message: 'Укажите email получателя (to)' });
    }

    const from = process.env.EMAIL_FROM || process.env.EMAIL_USER;
    const results = [];

    for (const template of Object.keys(TEMPLATE_META)) {
        const built = buildTemplate(template, {
            name,
            code,
            orderId,
            details,
            reason,
            documents,
        });

        try {
            const result = await sendEmail({
                to,
                subject: built.subject,
                text: built.text,
                html: built.html,
            });

            results.push({
                template,
                status: 'sent',
                subject: built.subject,
                messageId: result.MessageId,
            });
        } catch (err) {
            results.push({
                template,
                status: 'error',
                subject: built.subject,
                error: err.message,
            });
        }
    }

    const sent = results.filter((item) => item.status === 'sent').length;
    const failed = results.length - sent;

    res.status(failed ? 207 : 200).json({
        message:
            failed === 0
                ? 'Все тестовые письма отправлены'
                : `Отправлено ${sent} из ${results.length} писем`,
        from,
        to,
        results,
    });
};
