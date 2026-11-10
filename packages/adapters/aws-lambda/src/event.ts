/**
 * The parts of a Lambda function URL or API Gateway HTTP API event (payload format 2.0) the adapter reads. Defined
 * here, structurally, so the package needs no `@types/aws-lambda`; a full `APIGatewayProxyEventV2` is assignable.
 */
export interface LambdaEventV2 {
  /** The path, not URL-decoded. */
  readonly rawPath: string;
  /** The query string without `?`, not URL-decoded; may be empty or missing. */
  readonly rawQueryString?: string | undefined;
  /** Header names are lowercase; repeated headers are joined with commas. `Cookie` is in `cookies` instead. */
  readonly headers?: Readonly<Record<string, string | undefined>> | undefined;
  /** The request's cookies, one `name=value` pair per entry. */
  readonly cookies?: readonly string[] | undefined;
  readonly body?: string | undefined;
  readonly isBase64Encoded?: boolean | undefined;
  readonly requestContext: {
    /** The host the event arrived on, e.g. `<url-id>.lambda-url.<region>.on.aws`. */
    readonly domainName?: string | undefined;
    readonly http: {
      readonly method: string;
      /** The address of whatever connected to Lambda: CloudFront's, when CloudFront is in front. */
      readonly sourceIp?: string | undefined;
    };
  };
}

/** A function URL or HTTP API (payload format 2.0) response. */
export interface LambdaResultV2 {
  readonly statusCode: number;
  /** Every header except `Set-Cookie`. */
  readonly headers: Readonly<Record<string, string>>;
  /** One entry per `Set-Cookie` header: Lambda drops repeated headers, so cookies must go here. */
  readonly cookies: readonly string[];
  readonly body: string;
  readonly isBase64Encoded: boolean;
}
