type LiveSessionValidator = ((value: unknown) => boolean) & {
  errors?: unknown;
};

declare const validate: LiveSessionValidator;

export { validate };
export default validate;
