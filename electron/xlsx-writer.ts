import ExcelJS from "exceljs";

/**
 * Writes a WorkbookModel to disk.
 *
 * The types below mirror src/report.ts. They are declared twice on purpose:
 * tsconfig.electron.json pins rootDir to "electron", so this file cannot import
 * from src/, and widening rootDir would change the output layout and break
 * package.json's `main: dist-electron/main.js`. The two sides are separately
 * compiled programs talking over structured clone, so the contract is
 * structural in reality. tests/xlsx-writer.spec.ts is what enforces it.
 */

export type CellValue = number | string | boolean | null;

export interface ColumnDef {
  key: string;
  header: string;
}

export interface SheetModel {
  name: string;
  columns: ColumnDef[];
  rows: CellValue[][];
}

export interface WorkbookModel {
  sheets: SheetModel[];
  truncatedMultiSolid: number;
  skipped: number;
}

export async function writeWorkbook(
  filePath: string,
  model: WorkbookModel,
): Promise<void> {
  const book = new ExcelJS.Workbook();
  book.creator = "IFC Viewer";

  for (const sheet of model.sheets) {
    const worksheet = book.addWorksheet(sheet.name);
    worksheet.addRow(sheet.columns.map((c) => c.header));
    const header = worksheet.getRow(1);
    header.font = { bold: true };
    header.commit();

    for (const row of sheet.rows) {
      // null becomes an empty cell rather than the text "null".
      worksheet.addRow(row.map((v) => (v === null ? undefined : v)));
    }

    // Freeze the header so it stays put while scrolling 1300 rows, and give
    // every column a filter. The Model sheet is key/value, so it gets neither.
    if (sheet.name !== "Model") {
      worksheet.views = [{ state: "frozen", ySplit: 1 }];
      if (sheet.columns.length > 0 && sheet.rows.length > 0) {
        worksheet.autoFilter = {
          from: { row: 1, column: 1 },
          to: { row: 1, column: sheet.columns.length },
        };
      }
    }

    for (let i = 0; i < sheet.columns.length; i++) {
      // Wide enough for the header, which carries the unit suffix.
      worksheet.getColumn(i + 1).width = Math.min(
        40,
        Math.max(12, (sheet.columns[i]?.header.length ?? 12) + 2),
      );
    }
  }

  await book.xlsx.writeFile(filePath);
}
