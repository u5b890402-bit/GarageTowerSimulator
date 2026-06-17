import { JsonReportGenerator } from "./report/json-report-generator.js";

async function main(): Promise<void> {
  const rawOutputPath = process.argv[2] ?? "output/example-3x3-baseline.jsonl";
  const destinationPath = process.argv[3] ?? "output/example-3x3-report.json";
  const generator = new JsonReportGenerator();
  const report = await generator.generate({ path: rawOutputPath }, { destinationPath });
  await generator.write(report, destinationPath);

  console.log(`Report complete: ${destinationPath}`);
  console.log(`Daily rows: ${report.daily.length}`);
  console.log(`Successful activities: ${report.thirtyDaySummary.sum.successfulActivities}`);
  console.log(`Revenue: ${report.thirtyDaySummary.sum.totalRevenue}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
