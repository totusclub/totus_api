const BRAND = {
    siteUrl: 'https://totus.club',
    logoUrl: 'https://totus.club/apple-touch-icon.png',
    orange: '#FE732E',
    orangeHover: '#EF8019',
    blue: '#2BAAE2',
    dark: '#1F1F1F',
    gray: '#7A7A7A',
    lightGray: '#B6B6B6',
    bg: '#F7F7F7',
    card: '#FFFFFF',
    border: '#ECECEC',
};

function emailShell({ title, bodyHtml, footerNote }) {
    const year = new Date().getFullYear();

    return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:${BRAND.dark};">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:${BRAND.bg};padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;">
          <tr>
            <td align="center" style="padding:0 0 24px;">
              <a href="${BRAND.siteUrl}" target="_blank" style="text-decoration:none;">
                <img src="${BRAND.logoUrl}" alt="Totus Club" width="72" height="72" style="display:block;width:72px;height:72px;border:0;border-radius:16px;">
              </a>
            </td>
          </tr>
          <tr>
            <td style="background-color:${BRAND.card};border-radius:20px;overflow:hidden;border:1px solid ${BRAND.border};box-shadow:0 4px 24px rgba(31,31,31,0.06);">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                ${bodyHtml}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 12px 0;text-align:center;">
              <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:${BRAND.gray};">&copy; ${year} Totus Club. Все права защищены.</p>
              ${footerNote ? `<p style="margin:0;font-size:12px;line-height:1.6;color:${BRAND.lightGray};">${footerNote}</p>` : ''}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function welcomeTotusClubTemplate({ name } = {}) {
    const greeting = name ? `Здравствуйте, ${name}!` : 'Добро пожаловать!';

    const bodyHtml = `
          <tr>
            <td style="padding:36px 36px 28px;text-align:center;border-bottom:1px solid ${BRAND.border};">
              <p style="margin:0 0 10px;font-size:13px;line-height:1.4;color:${BRAND.orange};font-weight:700;letter-spacing:1px;text-transform:uppercase;">Totus Club</p>
              <h1 style="margin:0;font-size:28px;line-height:1.25;color:${BRAND.dark};font-weight:700;">Путешествия начинаются здесь</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 36px 8px;">
              <p style="margin:0 0 14px;font-size:18px;line-height:1.5;color:${BRAND.dark};font-weight:600;">${greeting}</p>
              <p style="margin:0;font-size:16px;line-height:1.7;color:${BRAND.gray};">
                Мы рады видеть вас в <strong style="color:${BRAND.dark};">Totus Club</strong> — туристическом клубе для подбора туров, отелей и путешествий по России и миру.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 36px 28px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td width="33%" valign="top" style="padding:8px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${BRAND.bg};border-radius:14px;border:1px solid ${BRAND.border};">
                      <tr><td style="padding:18px 14px;text-align:center;">
                        <div style="font-size:24px;line-height:1;margin-bottom:8px;">✈️</div>
                        <p style="margin:0;font-size:13px;line-height:1.5;color:${BRAND.dark};font-weight:600;">Туры с перелётом</p>
                      </td></tr>
                    </table>
                  </td>
                  <td width="33%" valign="top" style="padding:8px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${BRAND.bg};border-radius:14px;border:1px solid ${BRAND.border};">
                      <tr><td style="padding:18px 14px;text-align:center;">
                        <div style="font-size:24px;line-height:1;margin-bottom:8px;">🏨</div>
                        <p style="margin:0;font-size:13px;line-height:1.5;color:${BRAND.dark};font-weight:600;">Отели</p>
                      </td></tr>
                    </table>
                  </td>
                  <td width="33%" valign="top" style="padding:8px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${BRAND.bg};border-radius:14px;border:1px solid ${BRAND.border};">
                      <tr><td style="padding:18px 14px;text-align:center;">
                        <div style="font-size:24px;line-height:1;margin-bottom:8px;">🌍</div>
                        <p style="margin:0;font-size:13px;line-height:1.5;color:${BRAND.dark};font-weight:600;">Популярные направления</p>
                      </td></tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 36px 32px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:linear-gradient(135deg, rgba(254,115,46,0.08) 0%, rgba(43,170,226,0.08) 100%);border-radius:16px;border:1px solid ${BRAND.border};">
                <tr>
                  <td style="padding:24px;">
                    <p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:${BRAND.orange};font-weight:700;">Что вас ждёт</p>
                    <p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:${BRAND.gray};">&#10003; Выгодные предложения и онлайн-бронирование</p>
                    <p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:${BRAND.gray};">&#10003; Подбор туров и сопровождение путешественников</p>
                    <p style="margin:0;font-size:15px;line-height:1.6;color:${BRAND.gray};">&#10003; Бонусы программы лояльности</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 36px 36px;">
              <a href="${BRAND.siteUrl}" target="_blank" style="display:inline-block;padding:15px 36px;background-color:${BRAND.orange};color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;border-radius:999px;">Найти тур</a>
            </td>
          </tr>`;

    const html = emailShell({
        title: 'Добро пожаловать в Totus Club',
        bodyHtml,
        footerNote: 'Тестовое сообщение отправлено с noreply@totus.club',
    });

    const text = `${greeting}

Путешествия начинаются здесь — Totus Club.

Мы рады видеть вас в Totus Club — туристическом клубе для подбора туров, отелей и путешествий по России и миру.

Что вас ждёт:
- Выгодные предложения и онлайн-бронирование
- Подбор туров и сопровождение путешественников
- Бонусы программы лояльности

Найти тур: ${BRAND.siteUrl}`;

    return {
        subject: 'Добро пожаловать в Totus Club',
        html,
        text,
    };
}

function verificationCodeTemplate(code, { name } = {}) {
    const greeting = name
        ? `<p style="margin:0 0 8px;font-size:16px;line-height:1.5;color:${BRAND.dark};font-weight:600;">Здравствуйте, ${name}!</p>`
        : '';

    const bodyHtml = `
          <tr>
            <td style="padding:36px 36px 24px;text-align:center;border-bottom:1px solid ${BRAND.border};">
              <p style="margin:0 0 10px;font-size:13px;line-height:1.4;color:${BRAND.orange};font-weight:700;letter-spacing:1px;text-transform:uppercase;">Totus Club</p>
              <h1 style="margin:0;font-size:26px;line-height:1.3;color:${BRAND.dark};font-weight:700;">Код подтверждения</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 36px 8px;text-align:center;">
              ${greeting}
              <p style="margin:0;font-size:15px;line-height:1.6;color:${BRAND.gray};">Введите этот код для входа или регистрации в Totus Club</p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:16px 36px 28px;">
              <div style="display:inline-block;padding:18px 36px;background-color:${BRAND.bg};border:2px solid ${BRAND.orange};border-radius:16px;font-size:34px;font-weight:700;letter-spacing:10px;color:${BRAND.orange};">${code}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:0 36px 36px;text-align:center;">
              <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:${BRAND.lightGray};">Код действителен в течение 10 минут.</p>
              <p style="margin:0;font-size:13px;line-height:1.6;color:${BRAND.lightGray};">Если вы не запрашивали этот код, просто проигнорируйте это письмо.</p>
            </td>
          </tr>`;

    const greetingText = name ? `Здравствуйте, ${name}!\n\n` : '';

    const html = emailShell({
        title: 'Код подтверждения Totus Club',
        bodyHtml,
        footerNote: 'Письмо отправлено с noreply@totus.club',
    });

    return {
        subject: 'Код подтверждения Totus Club',
        text: `${greetingText}Ваш код подтверждения: ${code}\n\nКод действителен в течение 10 минут.\nЕсли вы не запрашивали этот код, просто проигнорируйте это письмо.`,
        html,
    };
}

module.exports = { welcomeTotusClubTemplate, verificationCodeTemplate };
