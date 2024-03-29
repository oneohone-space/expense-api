import { ForbiddenException } from '@nestjs/common';
import { ExchangeNameEnum } from '@prisma/client';
import { kraken } from 'ccxt';
import { EMPTY, catchError, delay, expand, from, reduce, tap } from 'rxjs';
import { GetExchangeDto } from 'src/lib/exchange/dto';
import { BaseExchange } from 'src/lib/exchange/exchange.base';

export class KrakenExchange extends BaseExchange {
  public declare exchange: kraken;
  constructor(exchangeDto: GetExchangeDto) {
    super(exchangeDto);
    this.name = ExchangeNameEnum.KRAKEN;
    // Respect the exchange's rate limits (https://docs.kraken.com/rest/#section/Rate-Limits)
    this.rateLimit = 3000;
    this.exchange = new kraken({
      apiKey: this.apiKey,
      secret: this.apiSecret,
      // Rate limit config
      enableRateLimit: true, // Enabled by default
      rateLimit: this.rateLimit,
    });

    // Enable debug mode to see the HTTP requests and responses in details
    // this.exchange.verbose = true;
  }

  /**
   * Send a sample request to ensure that the provided credentials are correct.
   */
  async validateCredentials() {
    try {
      await this.exchange.privatePostGetWebSocketsToken();
      return true;
    } catch (err) {
      // A PermissionDenied will be thrown if websockets are not enabled on the API credentials
      if (['AuthenticationError', 'PermissionDenied'].includes(err.name)) {
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

  private _fetchClosedOrders(
    startDateObj: Date,
    endDateObj: Date,
    ofs: number,
  ) {
    this.logger.log(
      `Fetching orders: startDate ${startDateObj.toISOString()} (${
        startDateObj.getTime() / 1000
      }), endDate ${endDateObj.toISOString()} (${
        endDateObj.getTime() / 1000
      }), offset ${ofs}`,
    );
    const symbol = undefined;
    const since = undefined;
    const limit = undefined;
    // See API endpoint details here: https://docs.kraken.com/rest/#tag/Account-Data/operation/getClosedOrders
    return this.exchange.fetchClosedOrders(symbol, since, limit, {
      trades: true,
      start: startDateObj.getTime() / 1000,
      end: endDateObj.getTime() / 1000,
      ofs,
    });
  }

  /**
   * Sync the orders of a user with his exchange account
   *
   *
   */
  syncOrders(startDateObj: Date, endDateObj: Date) {
    // Default kraken API page size
    const pageSize = 50;

    this.logger.debug(
      `[START] Sync orders using key "${this.apiKey}" in "${this.name}"`,
    );

    let page = 1;
    let ofs = 0;
    // Request the first page
    const paginationObs = from(
      Promise.resolve(this._fetchClosedOrders(startDateObj, endDateObj, ofs)),
    ).pipe(
      catchError((error: any) => {
        this.logger.error(error);
        throw new Error(`An ${error.name} error occurred (${error})`);
      }),
      tap(() => this.logger.log(`Fetched page: ${page}, ofs: ${ofs}`)),
      tap(() =>
        this.logger.log(`Going to sleep for ${this.rateLimit / 1000}secs...`),
      ),
      // Delay the next request to respect the exchange rate limits
      delay(this.rateLimit),
      tap(() => this.logger.log(`Slept for ${this.rateLimit / 1000}secs`)),
      // Use expand to recursively request the next pages
      expand((res) => {
        if (res.length < pageSize) {
          return EMPTY;
        }

        // Adjust pagination params to fetch the next page
        page += 1;
        ofs += res.length;

        return from(
          // Use ofset pagination for a given date window
          Promise.resolve(
            this._fetchClosedOrders(startDateObj, endDateObj, ofs),
          ),
        ).pipe(
          catchError((error: any) => {
            this.logger.error(error);
            throw new Error(`An ${error.name} error occurred (${error})`);
          }),
          tap(() => this.logger.log(`  - Fetched page: ${page}, ofs: ${ofs}`)),
          tap(() =>
            this.logger.log(
              `About to sleep for ${this.rateLimit / 1000}secs...`,
            ),
          ),
          delay(this.rateLimit),
          tap(() => this.logger.log(`Slept for ${this.rateLimit / 1000}secs`)),
        );
      }),
      tap(() => this.logger.log(`    * Processing page ${page}`)),
      reduce((allOrders, orderPage) => {
        const allOrdersObj = {};
        const orderedres = [];
        console.log('IN REDUCE: ');
        orderPage.forEach((o) => {
          orderedres.push({ dt: o.datetime, orderId: o.id });
          allOrdersObj[o.id] = o;
        });
        console.log(
          `Orders count: ${orderedres.length}, page: ${page}, offset: ${ofs}`,
        );
        console.log({ orderedres });
        return allOrders.concat(orderPage);
      }, []),
      tap(() => {
        this.logger.debug(
          `[END] Sync orders using key "${this.apiKey}" in "${this.name}"`,
        );
      }),
    );

    return paginationObs;
  }
}
