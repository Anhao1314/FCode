// Synthetic public HTML shape for adversarial HTTP checks; never a real/private connector receipt.
const makeRow = (name, value, prior = "30,429") => `<tr><td>${name}</td><td></td><td>${value}</td><td></td><td></td><td>${prior}</td><td></td></tr>`;
const durationHeader = `<tr><td></td><td></td><td>2026</td><td></td><td></td><td>2025</td></tr><tr><td></td><td></td><td>USD&#39;000</td><td></td><td></td><td>USD'000</td></tr>`;
// Shape replayed from the real issuer's static HTML tables; all extraction binds labeled columns.
const minimaxHtml = () => `<h1>MiniMax Announces First Half 2026 Financial Results</h1><p>MiniMax Group Inc. HKEX: 00100</p>
<p>Total revenue US$116.6 million; platform revenue US$73.9 million; product price US$0.30; loss per share US$1.18.</p>
<table><tr><td>INTERIM CONDENSED CONSOLIDATED INCOME STATEMENT</td></tr><tr><td>For the six months ended June 30, 2026</td></tr>${durationHeader}
${makeRow("REVENUE", "116,573")}${makeRow("Cost of sales", "(95,760)")}${makeRow("Gross profit", "20,813")}${makeRow("LOSS FOR THE PERIOD", "(357,997)")}${makeRow("Research and development expenses", "(296,870)")}${makeRow("Basic and diluted– For loss for the period (USD)", "(1.18)")}</table>
<table><tr><td>INTERIM CONDENSED CONSOLIDATED BALANCE SHEET</td></tr><tr><td></td><td></td><td>June 30,</td><td></td><td></td><td>December 31,</td></tr>${durationHeader}
${makeRow("Cash and cash equivalents", "930,905")}${makeRow("Total current assets", "1,428,617")}${makeRow("Total current liabilities", "362,932")}</table>
<table><tr><td>Reconciliation of Non-IFRS Measures</td></tr><tr><td>For the six months ended June 30, 2026</td></tr>${durationHeader}${makeRow("Adjusted net loss (non-IFRS measure<sup>(3)</sup>)", "(293,031)")}</table>`;

export { minimaxHtml };
