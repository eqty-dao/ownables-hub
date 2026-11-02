import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, from, throwError } from 'rxjs';
import { catchError, finalize, switchMap } from 'rxjs/operators';
import { CapacityError } from '../interfaces/error';
import { QuarantineService } from './quarantine.service';

@Injectable()
export class QuarantineUploadInterceptor implements NestInterceptor {
  constructor(private readonly quarantine: QuarantineService) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return from(this.quarantine.acquireIngress()).pipe(
      switchMap((release) => next.handle().pipe(finalize(() => void release()))),
      catchError((error: unknown) => {
        if (error instanceof CapacityError) {
          return throwError(() => new HttpException({ code: error.code, message: error.message }, error.status));
        }
        return throwError(() => error);
      }),
    );
  }
}
