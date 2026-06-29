const { sendEmail } = require('../utils/yandexCloudEmail');
const { welcomeTotusClubTemplate } = require('../utils/emailTemplates');

exports.sendTestEmail = async (req, res) => {
    const { to, name, subject, text, html } = req.body;

    if (!to) {
        return res.status(400).json({ message: 'Укажите email получателя (to)' });
    }

    const from = process.env.EMAIL_FROM || process.env.EMAIL_USER;
    const template = welcomeTotusClubTemplate({ name });

    try {
        const result = await sendEmail({
            to,
            subject: subject || template.subject,
            text: text || template.text,
            html: html || template.html,
        });

        res.status(200).json({
            message: 'Тестовое письмо отправлено',
            from,
            to,
            messageId: result.MessageId,
        });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось отправить тестовое письмо', error: err.message });
    }
};
