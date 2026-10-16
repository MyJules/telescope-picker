export class LatestRequest {
  private generation = 0;
  next(): number { return ++this.generation; }
  isCurrent(generation: number): boolean { return generation === this.generation; }
  cancel(): void { this.generation++; }
}
