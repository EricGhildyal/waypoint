-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "currentStage" TEXT,
    "pauseReason" TEXT,
    "failureCode" TEXT,
    "failureDetail" TEXT,
    "checklist" JSONB,
    "planningModel" TEXT NOT NULL,
    "implementationModel" TEXT NOT NULL,
    "reviewModel" TEXT NOT NULL,
    "testingModel" TEXT NOT NULL,
    "skipTesting" BOOLEAN NOT NULL DEFAULT false,
    "scheduledAt" DATETIME,
    "dependsOnTaskId" TEXT,
    "tokenBudget" INTEGER,
    "branchName" TEXT,
    "prUrl" TEXT,
    "reviewCycles" INTEGER NOT NULL DEFAULT 0,
    "testingCycles" INTEGER NOT NULL DEFAULT 0,
    "containerId" TEXT,
    "runnerToken" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "endedAt" DATETIME,
    CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Task_dependsOnTaskId_fkey" FOREIGN KEY ("dependsOnTaskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Task" ("branchName", "checklist", "containerId", "createdAt", "createdById", "currentStage", "dependsOnTaskId", "difficulty", "endedAt", "failureCode", "failureDetail", "id", "implementationModel", "pauseReason", "planningModel", "prUrl", "projectId", "prompt", "reviewCycles", "reviewModel", "runnerToken", "scheduledAt", "startedAt", "status", "testingCycles", "testingModel", "title", "tokenBudget", "updatedAt") SELECT "branchName", "checklist", "containerId", "createdAt", "createdById", "currentStage", "dependsOnTaskId", "difficulty", "endedAt", "failureCode", "failureDetail", "id", "implementationModel", "pauseReason", "planningModel", "prUrl", "projectId", "prompt", "reviewCycles", "reviewModel", "runnerToken", "scheduledAt", "startedAt", "status", "testingCycles", "testingModel", "title", "tokenBudget", "updatedAt" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
CREATE UNIQUE INDEX "Task_runnerToken_key" ON "Task"("runnerToken");
CREATE INDEX "Task_status_idx" ON "Task"("status");
CREATE INDEX "Task_projectId_idx" ON "Task"("projectId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
