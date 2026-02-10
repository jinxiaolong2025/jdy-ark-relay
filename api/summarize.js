const pdfParse = require("pdf-parse");

const ARK_BASE_URL = process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";
const ARK_API_KEY = process.env.ARK_API_KEY || "";
const ARK_MODEL = process.env.ARK_MODEL || "";
const JDY_TOKEN = process.env.JDY_TOKEN || "";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
}

function splitUrls(val) {
  const out = [];
  const add = (x) => {
    if (!x) return;
    if (typeof x === "string") {
      x.split(/[\s,]+/).forEach(s => s.startsWith("http") && out.push(s));
    } else if (Array.isArray(x)) {
      x.forEach(add);
    } else if (typeof x === "object") {
      ["url","downloadUrl","download_url","fileUrl","file_url"].forEach(k => {
        if (typeof x[k] === "string" && x[k].startsWith("http")) out.push(x[k]);
      });
    }
  };
  add(val);
  return [...new Set(out)];
}

async function download(url) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`download failed ${r.status}`);
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (JDY_TOKEN) {
    const token = req.headers["x-relay-token"] || "";
    if (token !== JDY_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  }

  if (!ARK_API_KEY) return res.status(500).json({ error: "ARK_API_KEY missing" });
  if (!ARK_MODEL) return res.status(500).json({ error: "ARK_MODEL missing" });

  let data = req.body;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { data = {}; }
  }

  const prompt = (data.prompt || data.text || "").trim();
  const imageUrls = splitUrls(data.image_urls || data.images);
  const pdfUrls = splitUrls(data.pdf_urls || data.pdfs || data.files);

  const pdfErrors = [];
  const pdfTexts = [];
  for (const u of pdfUrls) {
    try {
      const buf = await download(u);
      const parsed = await pdfParse(buf);
      const text = (parsed.text || "").trim();
      if (text) pdfTexts.push(text.slice(0, 20000));
      else pdfErrors.push(`PDF无可抽取文本: ${u}`);
    } catch (e) {
      pdfErrors.push(`PDF下载/解析失败: ${u} (${e.message})`);
    }
  }

  const content = [];
  content.push({
    type: "text",
    text:
      "任务：根据【电子发票PDF文本】+【图片】+【用户说明】，输出：\n" +
      "1) 关键要点总结（3-8条）\n" +
      "2) 发票核心字段（JSON）：invoice_no, invoice_date, seller_name, seller_tax_id, buyer_name, buyer_tax_id, amount_without_tax, tax_amount, amount_with_tax\n" +
      "3) 异常/缺失字段（如有）\n" +
      "规则：不要编造；没有就 null；金额保留两位小数。"
  });

  if (prompt) content.push({ type: "text", text: `【用户说明】\n${prompt}` });

  if (pdfTexts.length) {
    content.push({
      type: "text",
      text: pdfTexts.map((t, i) => `【PDF文本第${i+1}份】\n${t}`).join("\n\n---\n\n")
    });
  }

  for (const u of imageUrls) {
    content.push({ type: "image_url", image_url: { url: u } });
  }

  const payload = {
    model: ARK_MODEL,
    messages: [{ role: "user", content }],
    temperature: 0.2
  };

  try {
    const r = await fetch(`${ARK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ARK_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return res.status(502).json({ error: "ARK_HTTP_ERROR", status: r.status, detail: txt, pdf_errors: pdfErrors });
    }

    const ark = await r.json();
    const summary = ark?.choices?.[0]?.message?.content || "";
    const usage = ark?.usage || {};
    return res.status(200).json({ summary, usage, pdf_errors: pdfErrors });
  } catch (e) {
    return res.status(500).json({ error: "SERVER_ERROR", detail: e.message, pdf_errors: pdfErrors });
  }
};

