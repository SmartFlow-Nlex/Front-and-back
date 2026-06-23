import type { Request, Response, NextFunction } from "express";
import type { ZodTypeAny } from "zod";

export const validate = (schema: ZodTypeAny) => (req: Request, _res: Response, next: NextFunction) => {
  schema.parse({
    body: req.body,
    query: req.query,
    params: req.params,
  });
  next();
};
