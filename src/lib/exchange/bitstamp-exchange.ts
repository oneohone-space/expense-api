import { ForbiddenException } from '@nestjs/common';
import { ExchangeNameEnum } from '@prisma/client';
import { bitstamp } from 'ccxt';
import { GetExchangeDto } from 'src/lib/exchange/dto';
import { BaseExchange } from 'src/lib/exchange/exchange.base';
import { FetchDirection } from 'src/price/common/constants';

export class BitstampExchange extends BaseExchange {
  public declare exchange: bitstamp;
  public declare readonly rateLimit: number;
  public declare readonly fetchLimit: number;
  public declare readonly fetchDirection: FetchDirection;
  constructor(exchangeDto: GetExchangeDto) {
    super(exchangeDto);
    this.name = ExchangeNameEnum.BITSTAMP;
    // Bitstamp rate limits: https://www.bitstamp.net/api/#section/Request-limits
    // 400 requests per second, capped at 10,000 requests every 10 mins
    this.rateLimit = 1000;
    this.fetchLimit = 1000;
    this.fetchDirection = FetchDirection.ASC;
    this.exchange = new bitstamp({
      apiKey: this.apiKey,
      secret: this.apiSecret,
      // Rate limit config
      enableRateLimit: true, // Enabled by default
      rateLimit: this.rateLimit,
    });

    // Enable debug mode to see the HTTP requests and responses in details
    // this.exchange.verbose = true;
  }

  async validateCredentials() {
    try {
      const res = await this.exchange.privatePostWebsocketsToken();
      return true;
    } catch (err) {
      if (err.name === 'AuthenticationError') {
        return false;
      }
      throw new ForbiddenException(err);
    }
  }

  /**
   * Ensure that the provided credentials do not have access to sensitive information.
   *
   * The `fetchBalance` fn should throw an error.
   */
  async validateCredentialLimitations() {
    try {
      // It should throw an error
      await this.exchange.fetchBalance();
      // These credentials should not be accepted
      return false;
    } catch (err) {
      if (err.name === 'PermissionDenied') {
        return true;
      }
      throw new Error(err);
    }
  }
}
