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
  /** Optional overrides so the same layout renders quotations etc. */
  documentTitle?: string; // default "TAX INVOICE"
  detailsTitle?: string; // default "INVOICE DETAILS"
  dateLabel?: string; // default "Invoice Date"
  showFiscal?: boolean; // default true
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
    doc.fontSize(14).fillColor("#666").text(data.documentTitle ?? "TAX INVOICE", titleX, doc.y);
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
    doc.fillColor("#000").fontSize(10).font("Helvetica-Bold").text(data.detailsTitle ?? "INVOICE DETAILS", detailsX, detailsY);
    doc.fontSize(9).fillColor("#666").font("Helvetica");
    doc.text(`${data.dateLabel ?? "Invoice Date"}: ${data.issueDate ?? "—"}`, detailsX, doc.y);
    doc.text(`Status: ${data.status}`, detailsX, doc.y);

    doc.moveDown(1);

    // Table header with background
    const colDesc = { x: 48, width: 250 };
    const colQty = { x: 300, width: 40 };
    const colPrice = { x: 345, width: 75 };
    const colVat = { x: 425, width: 40 };
    const colTotal = { x: 470, width: 75 };
    const tableTop = doc.y;
    const headerHeight = 18;

    doc.rect(48, tableTop, 499, headerHeight).fillAndStroke("#f5f5f5", "#ddd");
    doc.fillColor("#333").fontSize(8).font("Helvetica-Bold");
    doc.text("Description", colDesc.x, tableTop + 5, { width: colDesc.width });
    doc.text("Qty", colQty.x, tableTop + 5, { width: colQty.width, align: "center" });
    doc.text("Unit Price [KES]", colPrice.x, tableTop + 5, { width: colPrice.width, align: "right" });
    doc.text("VAT %", colVat.x, tableTop + 5, { width: colVat.width, align: "center" });
    doc.text("Total [KES]", colTotal.x, tableTop + 5, { width: colTotal.width, align: "right" });
    doc.y = tableTop + headerHeight;

    // Table rows
    doc.fillColor("#000").fontSize(8).font("Helvetica");
    for (let i = 0; i < data.lines.length; i++) {
      const line = data.lines[i];
      const y = doc.y;
      const rowHeight = 18;

      // Alternate row background
      if (i % 2 === 0) {
        doc.rect(48, y, 499, rowHeight).fill("#fafafa");
      }

      // Draw row border
      doc.moveTo(48, y + rowHeight).lineTo(547, y + rowHeight).strokeColor("#eee").stroke();

      // Row content - align baseline
      const contentY = y + 4;
      doc.fillColor("#000").fontSize(8);
      doc.text(line.description, colDesc.x, contentY, { width: colDesc.width, continued: false });

      doc.fontSize(8).text(String(Number(line.quantity).toFixed(2)), colQty.x, contentY, {
        width: colQty.width,
        align: "center"
      });

      doc.text(kes(line.unit_price_cents), colPrice.x, contentY, {
        width: colPrice.width,
        align: "right"
      });

      const vatDisplay = line.vat_rate === "0.16" ? "16%" : line.vat_rate === "0" ? "0%" : "Exempt";
      doc.text(vatDisplay, colVat.x, contentY, {
        width: colVat.width,
        align: "center"
      });

      doc.text(kes(line.line_total_cents), colTotal.x, contentY, {
        width: colTotal.width,
        align: "right"
      });

      doc.y = y + rowHeight;
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

    // Fiscal information (invoices only)
    if (data.showFiscal !== false) {
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
