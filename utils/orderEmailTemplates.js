const { emailShell, BRAND } = require('./emailTemplates');

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function orderSummaryBlock({ orderId, details }) {
    return `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 24px;background:${BRAND.bg};border:1px solid ${BRAND.border};border-radius:14px;">
        <tr>
          <td style="padding:20px 22px;">
            <p style="margin:0 0 10px;font-size:13px;line-height:1.4;color:${BRAND.orange};font-weight:700;text-transform:uppercase;letter-spacing:1px;">Заказ №${escapeHtml(orderId)}</p>
            ${details ? `<p style="margin:0;font-size:15px;line-height:1.6;color:${BRAND.dark};font-weight:600;">${escapeHtml(details)}</p>` : ''}
          </td>
        </tr>
      </table>`;
}

function greetingBlock(name) {
    if (!name) return '';
    return `<p style="margin:0 0 14px;font-size:18px;line-height:1.5;color:${BRAND.dark};font-weight:600;">Здравствуйте, ${escapeHtml(name)}!</p>`;
}

function ctaButton(label, url) {
    return `
      <table role="presentation" cellspacing="0" cellpadding="0" align="center" style="margin:24px auto 0;">
        <tr>
          <td align="center" style="border-radius:999px;background-color:${BRAND.orange};">
            <a href="${url}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:999px;">${escapeHtml(label)}</a>
          </td>
        </tr>
      </table>`;
}

function documentsListHtml(documents) {
    if (!documents?.length) return '';
    const items = documents
        .map(
            (doc) =>
                `<p style="margin:0 0 10px;font-size:15px;line-height:1.6;color:${BRAND.gray};">&#128196; <a href="${escapeHtml(doc.url)}" target="_blank" style="color:${BRAND.orange};text-decoration:none;font-weight:600;">${escapeHtml(doc.title)}</a></p>`
        )
        .join('');
    return `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:20px 0 0;background:#fff8f3;border:1px solid #ffe2cc;border-radius:14px;">
        <tr>
          <td style="padding:20px 22px;">
            <p style="margin:0 0 12px;font-size:14px;line-height:1.4;color:${BRAND.orange};font-weight:700;">Документы</p>
            ${items}
          </td>
        </tr>
      </table>`;
}

function documentsListText(documents) {
    if (!documents?.length) return '';
    return `\n\nДокументы:\n${documents.map((doc) => `- ${doc.title}: ${doc.url}`).join('\n')}`;
}

function formatRubles(amount) {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return null;
    return new Intl.NumberFormat('ru-RU', {
        style: 'currency',
        currency: 'RUB',
        maximumFractionDigits: 0,
    }).format(value);
}

function paymentNoticeBlock({ amount, paymentMinutes = 30 }) {
    const formattedAmount = formatRubles(amount);
    return `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 24px;background:#fff8f3;border:1px solid #ffe2cc;border-radius:14px;">
        <tr>
          <td style="padding:20px 22px;">
            <p style="margin:0 0 10px;font-size:14px;line-height:1.5;color:${BRAND.orange};font-weight:700;">Оплата заказа</p>
            <p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:${BRAND.dark};">
              Для подтверждения бронирования оплатите заказ в течение <strong>${paymentMinutes} минут</strong>.
            </p>
            ${formattedAmount ? `<p style="margin:0;font-size:15px;line-height:1.6;color:${BRAND.gray};">Сумма к оплате: <strong style="color:${BRAND.dark};">${escapeHtml(formattedAmount)}</strong></p>` : ''}
          </td>
        </tr>
      </table>`;
}

function orderCreatedTemplate({ name, orderId, details, payUrl, amount, paymentMinutes = 30 }) {
    const formattedAmount = formatRubles(amount);
    const payButton = payUrl
        ? ctaButton('Оплатить через СБП', payUrl)
        : ctaButton('Открыть Totus Club', BRAND.siteUrl);

    const bodyHtml = `
          <tr>
            <td style="padding:36px 36px 24px;text-align:center;border-bottom:1px solid ${BRAND.border};">
              <p style="margin:0 0 10px;font-size:13px;line-height:1.4;color:${BRAND.orange};font-weight:700;letter-spacing:1px;text-transform:uppercase;">Totus Club</p>
              <h1 style="margin:0;font-size:26px;line-height:1.3;color:${BRAND.dark};font-weight:700;">Заказ создан</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 36px 36px;">
              ${greetingBlock(name)}
              <p style="margin:0 0 20px;font-size:16px;line-height:1.7;color:${BRAND.gray};">
                Ваш заказ успешно оформлен. Чтобы мы могли подтвердить бронирование, завершите оплату в течение ${paymentMinutes} минут.
              </p>
              ${orderSummaryBlock({ orderId, details })}
              ${paymentNoticeBlock({ amount, paymentMinutes })}
              <p style="margin:0;font-size:14px;line-height:1.7;color:${BRAND.lightGray};">
                Нажмите кнопку ниже, чтобы перейти к оплате через СБП.
              </p>
              ${payButton}
            </td>
          </tr>`;

    const amountText = formattedAmount ? `\nСумма к оплате: ${formattedAmount}` : '';
    const payText = payUrl ? `\nОплатить через СБП: ${payUrl}` : '';

    return {
        subject: `Заказ №${orderId} создан — оплатите в течение ${paymentMinutes} минут`,
        html: emailShell({ title: 'Заказ создан', bodyHtml, footerNote: 'Письмо отправлено с noreply@totus.club' }),
        text: `${name ? `Здравствуйте, ${name}!\n\n` : ''}Ваш заказ №${orderId} успешно создан. Оплатите его в течение ${paymentMinutes} минут.${amountText}${details ? `\n\n${details}` : ''}${payText}\n\nTotus Club: ${BRAND.siteUrl}`,
    };
}

function orderPaidPendingTemplate({ name, orderId, details, amount }) {
    const formattedAmount = formatRubles(amount);

    const bodyHtml = `
          <tr>
            <td style="padding:36px 36px 24px;text-align:center;border-bottom:1px solid ${BRAND.border};">
              <p style="margin:0 0 10px;font-size:13px;line-height:1.4;color:${BRAND.orange};font-weight:700;letter-spacing:1px;text-transform:uppercase;">Totus Club</p>
              <h1 style="margin:0;font-size:26px;line-height:1.3;color:${BRAND.dark};font-weight:700;">Оплата получена</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 36px 36px;">
              ${greetingBlock(name)}
              <p style="margin:0 0 20px;font-size:16px;line-height:1.7;color:${BRAND.gray};">
                Ваш платёж успешно принят. Заказ ожидает подтверждения бронирования — мы сообщим вам, как только процесс будет завершён.
              </p>
              ${orderSummaryBlock({ orderId, details })}
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 24px;background:#f0faf4;border:1px solid #cce8d4;border-radius:14px;">
                <tr>
                  <td style="padding:20px 22px;">
                    <p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:#1f7a3f;font-weight:700;">Статус оплаты</p>
                    <p style="margin:0;font-size:15px;line-height:1.6;color:${BRAND.gray};">
                      Оплачено${formattedAmount ? `: <strong style="color:${BRAND.dark};">${escapeHtml(formattedAmount)}</strong>` : ''}. Ожидаем подтверждение бронирования.
                    </p>
                  </td>
                </tr>
              </table>
              <p style="margin:0;font-size:14px;line-height:1.7;color:${BRAND.lightGray};">
                Спасибо за оплату. Следующее письмо придёт после подтверждения бронирования.
              </p>
              ${ctaButton('Открыть Totus Club', BRAND.siteUrl)}
            </td>
          </tr>`;

    const amountText = formattedAmount ? `\nСумма оплаты: ${formattedAmount}` : '';

    return {
        subject: `Оплата по заказу №${orderId} получена — Totus Club`,
        html: emailShell({ title: 'Оплата получена', bodyHtml, footerNote: 'Письмо отправлено с noreply@totus.club' }),
        text: `${name ? `Здравствуйте, ${name}!\n\n` : ''}Ваш платёж по заказу №${orderId} успешно получен. Заказ ожидает подтверждения бронирования.${amountText}${details ? `\n\n${details}` : ''}\n\nTotus Club: ${BRAND.siteUrl}`,
    };
}

function orderConfirmedTemplate({ name, orderId, details }) {
    const bodyHtml = `
          <tr>
            <td style="padding:36px 36px 24px;text-align:center;border-bottom:1px solid ${BRAND.border};">
              <p style="margin:0 0 10px;font-size:13px;line-height:1.4;color:${BRAND.orange};font-weight:700;letter-spacing:1px;text-transform:uppercase;">Totus Club</p>
              <h1 style="margin:0;font-size:26px;line-height:1.3;color:${BRAND.dark};font-weight:700;">Бронирование подтверждено</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 36px 36px;">
              ${greetingBlock(name)}
              <p style="margin:0 0 20px;font-size:16px;line-height:1.7;color:${BRAND.gray};">
                Отличные новости! Totus Club подтвердил ваше бронирование. Скоро мы отправим документы по поездке.
              </p>
              ${orderSummaryBlock({ orderId, details })}
              <p style="margin:0;font-size:14px;line-height:1.7;color:${BRAND.lightGray};">
                Спасибо, что выбрали Totus Club для вашего путешествия.
              </p>
              ${ctaButton('Перейти в Totus Club', BRAND.siteUrl)}
            </td>
          </tr>`;

    return {
        subject: `Бронирование №${orderId} подтверждено — Totus Club`,
        html: emailShell({ title: 'Бронирование подтверждено', bodyHtml, footerNote: 'Письмо отправлено с noreply@totus.club' }),
        text: `${name ? `Здравствуйте, ${name}!\n\n` : ''}Ваше бронирование №${orderId} подтверждено.\n${details ? `\n${details}\n` : ''}\nTotus Club: ${BRAND.siteUrl}`,
    };
}

function orderDocumentsTemplate({ name, orderId, details, documents }) {
    const bodyHtml = `
          <tr>
            <td style="padding:36px 36px 24px;text-align:center;border-bottom:1px solid ${BRAND.border};">
              <p style="margin:0 0 10px;font-size:13px;line-height:1.4;color:${BRAND.orange};font-weight:700;letter-spacing:1px;text-transform:uppercase;">Totus Club</p>
              <h1 style="margin:0;font-size:26px;line-height:1.3;color:${BRAND.dark};font-weight:700;">Документы готовы</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 36px 36px;">
              ${greetingBlock(name)}
              <p style="margin:0 0 20px;font-size:16px;line-height:1.7;color:${BRAND.gray};">
                Все документы по вашему заказу подготовлены. Вы можете скачать их по ссылкам ниже или из вложений к письму.
              </p>
              ${orderSummaryBlock({ orderId, details })}
              ${documentsListHtml(documents)}
              ${ctaButton('Открыть Totus Club', BRAND.siteUrl)}
            </td>
          </tr>`;

    return {
        subject: `Документы по заказу №${orderId} — Totus Club`,
        html: emailShell({ title: 'Документы по заказу', bodyHtml, footerNote: 'Письмо отправлено с noreply@totus.club' }),
        text: `${name ? `Здравствуйте, ${name}!\n\n` : ''}Документы по заказу №${orderId} готовы.${details ? `\n\n${details}` : ''}${documentsListText(documents)}\n\nTotus Club: ${BRAND.siteUrl}`,
    };
}

function orderCancelledTemplate({ name, orderId, details, reason }) {
    const bodyHtml = `
          <tr>
            <td style="padding:36px 36px 24px;text-align:center;border-bottom:1px solid ${BRAND.border};">
              <p style="margin:0 0 10px;font-size:13px;line-height:1.4;color:${BRAND.orange};font-weight:700;letter-spacing:1px;text-transform:uppercase;">Totus Club</p>
              <h1 style="margin:0;font-size:26px;line-height:1.3;color:${BRAND.dark};font-weight:700;">Заказ отменён</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 36px 36px;">
              ${greetingBlock(name)}
              <p style="margin:0 0 20px;font-size:16px;line-height:1.7;color:${BRAND.gray};">
                К сожалению, ваш заказ был отменён.${reason ? ` Причина: ${escapeHtml(reason)}.` : ''}
              </p>
              ${orderSummaryBlock({ orderId, details })}
              <p style="margin:0;font-size:14px;line-height:1.7;color:${BRAND.lightGray};">
                Если у вас есть вопросы, свяжитесь с нашей службой поддержки через сайт Totus Club.
              </p>
              ${ctaButton('Связаться с Totus Club', BRAND.siteUrl)}
            </td>
          </tr>`;

    return {
        subject: `Заказ №${orderId} отменён — Totus Club`,
        html: emailShell({ title: 'Заказ отменён', bodyHtml, footerNote: 'Письмо отправлено с noreply@totus.club' }),
        text: `${name ? `Здравствуйте, ${name}!\n\n` : ''}Ваш заказ №${orderId} был отменён.${reason ? ` Причина: ${reason}.` : ''}${details ? `\n\n${details}` : ''}\n\nTotus Club: ${BRAND.siteUrl}`,
    };
}

module.exports = {
    orderCreatedTemplate,
    orderPaidPendingTemplate,
    orderConfirmedTemplate,
    orderDocumentsTemplate,
    orderCancelledTemplate,
};
