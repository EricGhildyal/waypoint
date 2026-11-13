-- One test command + coverage config per project becomes a list of test
-- suites (JSON), so e.g. a frontend and a backend are run and gated separately.
ALTER TABLE "Project" ADD COLUMN "testSuites" TEXT NOT NULL DEFAULT '[]';

UPDATE "Project"
SET "testSuites" = json_array(
  json_object(
    'name', 'tests',
    'command', "testCommand",
    'workdir', '',
    'coverageEnabled', json(CASE WHEN "coverageEnabled" THEN 'true' ELSE 'false' END),
    'coverageFormat', "coverageFormat",
    'coverageReportPath', "coverageReportPath",
    'coverageBar', "coverageBar"
  )
)
WHERE "testCommand" IS NOT NULL AND trim("testCommand") <> '';

ALTER TABLE "Project" DROP COLUMN "testCommand";
ALTER TABLE "Project" DROP COLUMN "coverageEnabled";
ALTER TABLE "Project" DROP COLUMN "coverageFormat";
ALTER TABLE "Project" DROP COLUMN "coverageReportPath";
ALTER TABLE "Project" DROP COLUMN "coverageBar";
