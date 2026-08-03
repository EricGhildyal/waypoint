-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "repoUrl" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "branchTemplate" TEXT NOT NULL DEFAULT 'eric/{id}',
    "setupCommand" TEXT NOT NULL,
    "runCommand" TEXT NOT NULL,
    "runReadyUrl" TEXT,
    "migrateCommand" TEXT,
    "testCommand" TEXT,
    "coverageFormat" TEXT NOT NULL DEFAULT 'LCOV',
    "coverageReportPath" TEXT NOT NULL DEFAULT 'coverage/lcov.info',
    "lintCommand" TEXT,
    "formatCommand" TEXT,
    "dockerfilePath" TEXT,
    "instructions" TEXT NOT NULL DEFAULT '',
    "coverageBar" INTEGER NOT NULL DEFAULT 100,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Project" ("branchTemplate", "coverageBar", "coverageFormat", "coverageReportPath", "createdAt", "defaultBranch", "dockerfilePath", "formatCommand", "id", "instructions", "lintCommand", "migrateCommand", "name", "repoUrl", "runCommand", "runReadyUrl", "setupCommand", "testCommand", "updatedAt") SELECT "branchTemplate", "coverageBar", "coverageFormat", "coverageReportPath", "createdAt", "defaultBranch", "dockerfilePath", "formatCommand", "id", "instructions", "lintCommand", "migrateCommand", "name", "repoUrl", "runCommand", "runReadyUrl", "setupCommand", "testCommand", "updatedAt" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE UNIQUE INDEX "Project_name_key" ON "Project"("name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
