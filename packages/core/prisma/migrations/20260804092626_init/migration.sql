-- CreateTable
CREATE TABLE "Project" (
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

-- CreateTable
CREATE TABLE "Secret" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT,
    "key" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    CONSTRAINT "Secret_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Task" (
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
    "emailMessageId" TEXT,
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

-- CreateTable
CREATE TABLE "StageRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "sessionId" TEXT,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheCreationTokens" INTEGER NOT NULL DEFAULT 0,
    "transcriptPath" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    CONSTRAINT "StageRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "stageRunId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'QUESTION',
    "text" TEXT NOT NULL,
    "contextSummary" TEXT NOT NULL,
    "options" JSONB,
    "items" JSONB,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "answer" TEXT,
    "answeredVia" TEXT,
    "emailMessageId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" DATETIME,
    CONSTRAINT "Question_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SteeringMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" DATETIME,
    CONSTRAINT "SteeringMessage_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "stageRunId" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Event_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "AllowedEmail" (
    "email" TEXT NOT NULL PRIMARY KEY
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "image" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_name_key" ON "Project"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Secret_projectId_key_key" ON "Secret"("projectId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Task_runnerToken_key" ON "Task"("runnerToken");

-- CreateIndex
CREATE INDEX "Task_status_idx" ON "Task"("status");

-- CreateIndex
CREATE INDEX "Task_projectId_idx" ON "Task"("projectId");

-- CreateIndex
CREATE INDEX "StageRun_taskId_idx" ON "StageRun"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "StageRun_taskId_stage_attempt_key" ON "StageRun"("taskId", "stage", "attempt");

-- CreateIndex
CREATE INDEX "Question_taskId_status_idx" ON "Question"("taskId", "status");

-- CreateIndex
CREATE INDEX "SteeringMessage_taskId_deliveredAt_idx" ON "SteeringMessage"("taskId", "deliveredAt");

-- CreateIndex
CREATE INDEX "Event_taskId_createdAt_id_idx" ON "Event"("taskId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
