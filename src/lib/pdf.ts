// Table-to-PDF export -- the PDF counterpart of downloadCsv in utils.ts. Takes
// the same shape of column definitions (a header plus a function returning the
// cell text), so a page can hand the same columns to both exporters. The
// library is loaded on demand, so it never adds to a page's initial bundle.

export interface PdfColumn<T> {
  header: string
  value: (row: T) => string | number | null | undefined
  // Fixed width in points. Leave unset for the one wide, text-heavy column
  // (e.g. Details) that should soak up whatever width is left.
  width?: number
}

// jsPDF's built-in fonts only cover Latin-1 / Windows-1252, so anything else
// would print as garbage. Map the common typographic characters to plain
// equivalents and replace anything left over.
function pdfSafe(input: string): string {
  return input
    .replace(/[–—−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/→/g, '->')
    .replace(/ /g, ' ')
    .replace(/[^\n\x20-\xFF]/g, '?')
}

export async function downloadPdfTable<T>({
  filename, title, subtitle, columns, rows,
}: {
  filename: string
  title: string
  // One string per line under the title; a long line wraps on its own.
  subtitle?: string | string[]
  columns: PdfColumn<T>[]
  rows: T[]
}): Promise<void> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ])

  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 36

  // Title block -- first page only.
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(24)
  doc.setTextColor(45, 32, 58)
  doc.text(pdfSafe(title), margin, 50)
  // The table starts below however many lines the subtitle really took.
  let tableStartY = 70
  const subtitleItems = (Array.isArray(subtitle) ? subtitle : subtitle ? [subtitle] : []).filter(Boolean)
  if (subtitleItems.length > 0) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(11)
    doc.setTextColor(0, 0, 0)
    const lines = subtitleItems.flatMap(
      (t) => doc.splitTextToSize(pdfSafe(t), pageWidth - margin * 2) as string[],
    )
    const lineHeight = 15
    doc.text(lines, margin, 70, { lineHeightFactor: lineHeight / 11 })
    tableStartY = 70 + lines.length * lineHeight + 8
  }

  autoTable(doc, {
    startY: tableStartY,
    head: [columns.map((c) => pdfSafe(c.header))],
    body: rows.map((row) => columns.map((c) => pdfSafe(String(c.value(row) ?? '')))),
    margin: { left: margin, right: margin, top: margin, bottom: margin + 6 },
    styles: {
      font: 'helvetica', fontSize: 10, cellPadding: 5, overflow: 'linebreak',
      valign: 'top', lineColor: [224, 213, 231], lineWidth: 0.5, textColor: [45, 32, 58],
    },
    headStyles: { fillColor: [128, 70, 181], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 11 },
    alternateRowStyles: { fillColor: [248, 245, 251] },
    columnStyles: Object.fromEntries(
      columns.map((c, i) => [i, { cellWidth: c.width ?? ('auto' as const) }]),
    ),
    // Never split one entry across two pages if it fits on the next one.
    rowPageBreak: 'avoid',
  })

  // Footer with page numbers, once the total is known.
  const pageCount = doc.getNumberOfPages()
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(0, 0, 0)
    doc.text(`Page ${i} of ${pageCount}`, pageWidth - margin, pageHeight - 18, { align: 'right' })
  }

  doc.save(filename)
}
