const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Invoice PDFs are uploaded as base64 JSON. Keep the request limit bounded.
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname)));

const DATA_FILE = path.join(__dirname, 'database.json');
const PDF_MAX_BYTES = 8 * 1024 * 1024;
const SIGNED_URL_SECONDS = 60 * 60 * 24 * 30;

// Supabase credentials are server-only. Never put the service-role key in index.html.
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseBucket = process.env.SUPABASE_INVOICE_BUCKET || 'invoices';
const supabase = supabaseUrl && supabaseServiceRoleKey
    ? createClient(supabaseUrl, supabaseServiceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false }
      })
    : null;

// Lightweight per-process throttling for the upload endpoint.
const uploadAttempts = new Map();
function limitInvoiceUploads(req, res, next) {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const windowMs = 10 * 60 * 1000;
    const maxAttempts = 20;
    const previous = uploadAttempts.get(ip) || [];
    const recent = previous.filter(timestamp => now - timestamp < windowMs);
    if (recent.length >= maxAttempts) {
        return res.status(429).json({ error: 'Too many invoice uploads. Please try again later.' });
    }
    recent.push(now);
    uploadAttempts.set(ip, recent);
    next();
}

app.get('/api/data', (req, res) => {
    if (!fs.existsSync(DATA_FILE)) {
        return res.json({ inventory: [], bills: [] });
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
        res.json({ success: true, message: 'Data saved successfully!' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to write database' });
    }
});

// Upload a generated invoice PDF to a private Supabase Storage bucket and
// return a time-limited link that the customer can open without an account.
app.post('/api/invoices/upload', limitInvoiceUploads, async (req, res) => {
    try {
        if (!supabase) {
            return res.status(503).json({
                error: 'Invoice sharing is not configured. Add Supabase environment variables on Render.'
            });
        }

        const { pdfBase64, invoiceNo } = req.body || {};
        if (typeof pdfBase64 !== 'string' || !pdfBase64.trim()) {
            return res.status(400).json({ error: 'A PDF file is required.' });
        }

        // Accept only a plain base64 payload, not a data URL or arbitrary content.
        const normalizedBase64 = pdfBase64;
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalizedBase64)) {
            return res.status(400).json({ error: 'Invalid PDF encoding.' });
        }

        const pdfBuffer = Buffer.from(normalizedBase64, 'base64');
        if (!pdfBuffer.length || pdfBuffer.length > PDF_MAX_BYTES) {
            return res.status(413).json({ error: 'PDF must be smaller than 8 MB.' });
        }
        if (pdfBuffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
            return res.status(400).json({ error: 'Uploaded file is not a valid PDF.' });
        }

        const shortId = crypto.randomUUID();
        const objectPath = `${shortId}.pdf`;

        const { error: uploadError } = await supabase.storage
            .from(supabaseBucket)
            .upload(objectPath, pdfBuffer, {
                contentType: 'application/pdf',
                upsert: false,
                cacheControl: '3600'
            });

        if (uploadError) {
            console.error('Supabase invoice upload failed:', uploadError.message);
            return res.status(502).json({ error: 'Could not store the invoice PDF.' });
        }

        // Return a short URL on this app. A fresh private Supabase URL is
        // generated only when the customer opens the short link.
        const baseUrl = process.env.APP_BASE_URL || `https://${req.get('host')}`;
        res.json({
            success: true,
            url: `${baseUrl.replace(/\/$/, '')}/i/${shortId}`
        });
    } catch (err) {
        console.error('Invoice upload error:', err);
        res.status(500).json({ error: 'Unexpected error while sharing invoice.' });
    }
});

app.get('/i/:id', async (req, res) => {
    try {
        const shortId = req.params.id;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shortId)) {
            return res.status(404).send('Invoice link not found.');
        }
        if (!supabase) {
            return res.status(503).send('Invoice sharing is temporarily unavailable.');
        }

        const { data, error } = await supabase.storage
            .from(supabaseBucket)
            .createSignedUrl(`${shortId}.pdf`, SIGNED_URL_SECONDS, {
                download: `OM_JEWELLERS_${shortId}.pdf`
            });

        if (error || !data?.signedUrl) {
            console.error('Short invoice link resolution failed:', error?.message);
            return res.status(404).send('This invoice link is invalid or the PDF is no longer available.');
        }

        res.redirect(302, data.signedUrl);
    } catch (err) {
        console.error('Short invoice link error:', err);
        res.status(500).send('Could not open this invoice right now.');
    }
});

app.listen(PORT, () => {
    console.log(`Om Jewellers server running at http://localhost:${PORT}`);
});
