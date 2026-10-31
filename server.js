const express = require('express');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const app = express();
const PORT = process.env.PORT || 3000;

// Allow large payloads for PDF base64 transfer
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.static(path.join(__dirname)));

const DATA_FILE = path.join(__dirname, 'database.json');

// Initialize WhatsApp Web Client with persistent local session
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

let isWhatsAppReady = false;

client.on('qr', (qr) => {
    console.log('\n==================================================');
    console.log('SCAN THIS QR CODE WITH YOUR SHOP WHATSAPP:');
    console.log('==================================================\n');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    isWhatsAppReady = true;
    console.log('\n>>> WhatsApp Bot is connected and ready to send bills! <<<\n');
});

client.on('authenticated', () => {
    console.log('WhatsApp authenticated successfully.');
});

client.on('auth_failure', (msg) => {
    console.error('WhatsApp authentication failure:', msg);
});

client.initialize();

// Data endpoints
app.get('/api/data', (req, res) => {
    if (!fs.existsSync(DATA_FILE)) {
        return res.json({ inventory: [] });
    }
    try {
        const data = fs.readFileSync(DATA_FILE, 'utf8');
        res.json(JSON.parse(data));
    } catch (err) {
        res.status(500).json({ error: 'Failed to read database' });
    }
});

app.post('/api/data', (req, res) => {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(req.body, null, 2));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to write database' });
    }
});

// Endpoint: Send PDF & Message directly to customer WhatsApp
app.post('/api/send-bill-whatsapp', async (req, res) => {
    if (!isWhatsAppReady) {
        return res.status(503).json({
            success: false,
            message: 'WhatsApp client is still initializing or not connected. Check terminal QR code.'
        });
    }

    const { phone, customerName, billNo, date, time, totalAmount, pdfBase64 } = req.body;

    if (!phone || !pdfBase64) {
        return res.status(400).json({ success: false, message: 'Phone number and PDF data are required.' });
    }

    try {
        // Clean phone number: remove non-digits
        let cleanPhone = phone.replace(/\D/g, '');
        // If 10 digits without country code, default to India (91)
        if (cleanPhone.length === 10) {
            cleanPhone = '91' + cleanPhone;
        }
        const chatId = `${cleanPhone}@c.us`;

        const caption = `*OM JEWELLERS* - Tax Invoice\n` +
            `Invoice #: ${billNo}\n` +
            `Date: ${date} | Time: ${time}\n` +
            `Billed To: ${customerName}\n` +
            `*Grand Total (inc. 3% GST): ₹${totalAmount}*\n\n` +
            `_Thank you for choosing us. We look forward to serving you again!_\n\n` +
            `*Warm Regards,\nOM JEWELLERS*`;

        const media = new MessageMedia('application/pdf', pdfBase64, `OM_JEWELLERS_${billNo}.pdf`);

        await client.sendMessage(chatId, media, { caption: caption });

        res.json({ success: true, message: 'PDF Bill sent to WhatsApp successfully!' });
    } catch (error) {
        console.error('Failed to send WhatsApp message:', error);
        res.status(500).json({ success: false, message: 'Failed to send WhatsApp message: ' + error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Om Jewellers server running at http://localhost:${PORT}`);
});