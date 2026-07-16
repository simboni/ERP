import PDFDocument from "pdfkit";

export interface InvoicePdfData {
  businessName: string;
  invoiceNo: number | string;
  status: string;
  issueDate: string | null;
  customerName: string;
  customerPin: string | null;
  logo: string | null;
  lines: {
    description: string;
    quantity: string | number;
    unit_price_cents: string | number;
    vat_rate: string;
    line_total_cents: string | number;
    vat_cents: string | number;
  }[];
  subtotalCents: number;
  vatCents: number;
  totalCents: number;
  fiscal: { controlNumber: string | null; qrPayload: string | null; status: string | null };
}

const kes = (c: number | string): string =>
  `KES ${(Number(c) / 100).toLocaleString("en-KE", { minimumFractionDigits: 2 })}`;

/** Render a professional tax invoice PDF with logo and branding. */
export function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Header with logo and business info
    const headerY = doc.y;
    if (data.logo) {
      try {
        doc.image(data.logo, 48, headerY, { height: 80 });
      } catch {
        // Logo failed to render, continue without it
      }
    }

    // Business name and invoice title on the right
    const titleX = data.logo ? 300 : 48;
    doc.fontSize(24).font("Helvetica-Bold").text(data.businessName, titleX, headerY);
    doc.fontSize(14).fillColor("#666").text(`TAX INVOICE`, titleX, doc.y);
    doc.fontSize(11).fillColor("#999").text(
      `${data.invoiceNo ? `#${data.invoiceNo}` : "(draft)"}`,
      titleX,
      doc.y,
    );

    // Horizontal line separator
    doc.moveTo(48, doc.y + 8).lineTo(547, doc.y + 8).strokeColor("#ddd").stroke();
    doc.moveDown(1.2);

    // Two-column layout: Bill To | Invoice Details
    const billToX = 48;
    const detailsX = 330;
    const colWidth = 180;

    doc.fillColor("#000").fontSize(10).font("Helvetica-Bold").text("BILL TO", billToX, doc.y);
    doc.fontSize(11).font("Helvetica").text(data.customerName, billToX, doc.y);
    if (data.customerPin) {
      doc.fontSize(9).fillColor("#666").text(`KRA PIN: ${data.customerPin}`, billToX, doc.y);
    }

    const detailsY = doc.y - 30;
    doc.fillColor("#000").fontSize(10).font("Helvetica-Bold").text("INVOICE DETAILS", detailsX, detailsY);
    doc.fontSize(9).fillColor("#666").font("Helvetica");
    doc.text(`Invoice Date: ${data.issueDate ?? "—"}`, detailsX, doc.y);
    doc.text(`Status: ${data.status}`, detailsX, doc.y);

    doc.moveDown(1.2);

    // Table header with background
    const xDesc = 48;
    const xQty = 285;
    const xPrice = 345;
    const xVat = 420;
    const xTotal = 480;
    const tableTop = doc.y;

    doc.rect(xDesc - 5, tableTop, 502, 20).fillAndStroke("#f5f5f5", "#ddd");
    doc.fillColor("#333").fontSize(9).font("Helvetica-Bold");
    doc.text("Description", xDesc, tableTop + 5);
    doc.text("Qty", xQty, tableTop + 5, { align: "center" });
    doc.text("Unit Price [KES]", xPrice, tableTop + 5, { align: "right" });
    doc.text("VAT %", xVat, tableTop + 5, { align: "center" });
    doc.text("Total [KES]", xTotal, tableTop + 5, { align: "right" });
    doc.moveDown(1.2);

    // Table rows
    doc.fillColor("#000").fontSize(9).font("Helvetica");
    for (let i = 0; i < data.lines.length; i++) {
      const line = data.lines[i];
      const y = doc.y;
      const descHeight = doc.heightOfString(line.description, { width: 220 });
      const rowHeight = Math.max(descHeight + 6, 16);

      // Alternate row background
      if (i % 2 === 0) {
        doc.rect(xDesc - 5, y - 2, 502, rowHeight).fill("#fafafa");
      }

      doc.fillColor("#000");
      doc.text(line.description, xDesc, y, { width: 220 });
      doc.fontSize(8).text(String(Number(line.quantity)), xQty - 5, y + rowHeight - 11, { align: "center" });
      doc.fontSize(9).text(kes(line.unit_price_cents), xPrice - 5, y + rowHeight - 11, { align: "right" });
      doc.text(
        line.vat_rate === "0.16" ? "16%" : line.vat_rate === "0" ? "0%" : "Exempt",
        xVat - 5,
        y + rowHeight - 11,
        { align: "center" },
      );
      doc.text(kes(line.line_total_cents), xTotal - 5, y + rowHeight - 11, { align: "right" });
      doc.moveDown(rowHeight / 12);
    }

    // Summary section
    doc.moveDown(0.8);
    const summaryLabelX = 350;
    const summaryValueX = 480;

    doc.moveTo(summaryLabelX, doc.y).lineTo(547, doc.y).strokeColor("#ddd").stroke();
    doc.moveDown(0.5);

    doc.fontSize(9).fillColor("#666").font("Helvetica");
    doc.text("Subtotal:", summaryLabelX, doc.y, { width: 100 });
    doc.text(kes(data.subtotalCents), summaryValueX, doc.y - 13.5, { align: "right" });

    doc.moveDown(0.5);
    doc.text("VAT (16%):", summaryLabelX, doc.y, { width: 100 });
    doc.text(kes(data.vatCents), summaryValueX, doc.y - 13.5, { align: "right" });

    doc.moveDown(0.5);
    doc.moveTo(summaryLabelX, doc.y).lineTo(547, doc.y).strokeColor("#333").stroke();
    doc.moveDown(0.5);

    doc.fontSize(11).fillColor("#000").font("Helvetica-Bold");
    doc.text("TOTAL [KES]:", summaryLabelX, doc.y, { width: 100 });
    doc.text(kes(data.totalCents), summaryValueX, doc.y - 13.5, { align: "right" });

    // Fiscal information
    doc.moveDown(1.5);
    doc.fontSize(8).fillColor("#999").font("Helvetica");
    if (data.fiscal.controlNumber) {
      doc.text(`KRA eTIMS Control Number: ${data.fiscal.controlNumber}`);
      if (data.fiscal.qrPayload) {
        doc.text(`Verify at: ${data.fiscal.qrPayload}`, { underline: true });
      }
    } else {
      doc.text(`eTIMS Status: ${data.fiscal.status ?? "not fiscalized"}`);
    }

    // Footer
    doc.moveDown(2);
    doc.fontSize(7).fillColor("#bbb");
    doc.text("Generated by Jenga ERP — Modern business management", {
      align: "center",
    });

    doc.end();
  });
}
