export type ApiOk<T> = {
  success: true;
  data: T;
};

export type ApiErr = {
  success: false;
  message: string;
};
