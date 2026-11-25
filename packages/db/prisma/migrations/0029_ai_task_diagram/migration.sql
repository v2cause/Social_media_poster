-- Diagrams as images for posts (ADR 0048): Claude draws them as SVG, the API renders a JPEG. Each
-- call is recorded as an AiGeneration with its own task.

-- AlterEnum
ALTER TYPE "AiTask" ADD VALUE 'DIAGRAM';
