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
        const normalizedBase64 = pdfBase64.replace(/^data:application\\/pdf;base64,/, '');
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

        const safeInvoiceNo = String(invoiceNo || 'invoice').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'invoice';
        const objectPath = `${new Date().toISOString().slice(0, 10)}/${safeInvoiceNo}-${crypto.randomUUID()}.pdf`;

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

        const { data: signedData, error: signedError } = await supabase.storage
            .from(supabaseBucket)
            .createSignedUrl(objectPath, SIGNED_URL_SECONDS, {
                download: `${safeInvoiceNo}.pdf`
            });

        if (signedError || !signedData?.signedUrl) {
            console.error('Supabase signed URL failed:', signedError?.message);
            return res.status(502).json({ error: 'PDF was uploaded, but its share link could not be created.' });
        }

        res.json({
            success: true,
            url: signedData.signedUrl,
            expiresIn: SIGNED_URL_SECONDS
        });
    } catch (err) {
        console.error('Invoice upload error:', err);
        res.status(500).json({ error: 'Unexpected error while sharing invoice.' });
    }
});

app.listen(PORT, () => {
    console.log(`Om Jewellers server running at http://localhost:${PORT}`);
});
