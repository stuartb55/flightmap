import type { Database } from "./database.js";
import type { RepositoryConfig } from "./repository-shared.js";
import { IngestRepository } from "./ingest-repository.js";
import { LiveRepository } from "./live-repository.js";
import { HistoryRepository } from "./history-repository.js";
import { InsightsRepository } from "./insights-repository.js";
import { AlertsRepository } from "./alerts-repository.js";
import { SavedViewsRepository } from "./saved-views-repository.js";
import { StatusRepository } from "./status-repository.js";

export {
  RepositoryInputError,
  hasDetailedTrackAvailable,
  normaliseIcao
} from "./repository-shared.js";
export type { RepositoryConfig } from "./repository-shared.js";
export { IngestRepository } from "./ingest-repository.js";
export { LiveRepository } from "./live-repository.js";
export { HistoryRepository } from "./history-repository.js";
export { InsightsRepository } from "./insights-repository.js";
export { AlertsRepository } from "./alerts-repository.js";
export { SavedViewsRepository } from "./saved-views-repository.js";
export { StatusRepository } from "./status-repository.js";

/**
 * One entry point over the domain repositories. Each owns the SQL for its
 * own area — ingestion, live, history, insights, alerts, saved views and
 * status — and this class only forwards to them.
 */
export class FlightRepository {
  readonly ingest: IngestRepository;
  readonly live: LiveRepository;
  readonly history: HistoryRepository;
  readonly insights: InsightsRepository;
  readonly alertsRepository: AlertsRepository;
  readonly savedViewsRepository: SavedViewsRepository;
  readonly status: StatusRepository;

  constructor(database: Database, config: RepositoryConfig) {
    this.ingest = new IngestRepository(database, config);
    this.live = new LiveRepository(database, config);
    this.history = new HistoryRepository(database, config);
    this.insights = new InsightsRepository(database, config);
    this.alertsRepository = new AlertsRepository(database, config, this.live);
    this.savedViewsRepository = new SavedViewsRepository(database, config);
    this.status = new StatusRepository(database, config);
  }

  // Ingestion
  checkpoint = (...args: Parameters<IngestRepository["checkpoint"]>) =>
    this.ingest.checkpoint(...args);
  ingestSnapshot = (...args: Parameters<IngestRepository["ingestSnapshot"]>) =>
    this.ingest.ingestSnapshot(...args);
  removeExpiredCurrent = (...args: Parameters<IngestRepository["removeExpiredCurrent"]>) =>
    this.ingest.removeExpiredCurrent(...args);
  closeInactiveSessions = (...args: Parameters<IngestRepository["closeInactiveSessions"]>) =>
    this.ingest.closeInactiveSessions(...args);

  // Live
  liveAircraft = (...args: Parameters<LiveRepository["liveAircraft"]>) =>
    this.live.liveAircraft(...args);
  aircraftDetail = (...args: Parameters<LiveRepository["aircraftDetail"]>) =>
    this.live.aircraftDetail(...args);

  // History
  sessions = (...args: Parameters<HistoryRepository["sessions"]>) =>
    this.history.sessions(...args);
  track = (...args: Parameters<HistoryRepository["track"]>) =>
    this.history.track(...args);
  aircraftActivity = (...args: Parameters<HistoryRepository["aircraftActivity"]>) =>
    this.history.aircraftActivity(...args);
  summaries = (...args: Parameters<HistoryRepository["summaries"]>) =>
    this.history.summaries(...args);

  // Insights
  insightAvailability = (...args: Parameters<InsightsRepository["insightAvailability"]>) =>
    this.insights.insightAvailability(...args);
  insightsOverview = (...args: Parameters<InsightsRepository["insightsOverview"]>) =>
    this.insights.insightsOverview(...args);
  insightPatterns = (...args: Parameters<InsightsRepository["insightPatterns"]>) =>
    this.insights.insightPatterns(...args);
  rangeProfile = (...args: Parameters<InsightsRepository["rangeProfile"]>) =>
    this.insights.rangeProfile(...args);
  insightsCoverage = (...args: Parameters<InsightsRepository["insightsCoverage"]>) =>
    this.insights.insightsCoverage(...args);
  coverageCellDetail = (...args: Parameters<InsightsRepository["coverageCellDetail"]>) =>
    this.insights.coverageCellDetail(...args);
  receiverRecords = (...args: Parameters<InsightsRepository["receiverRecords"]>) =>
    this.insights.receiverRecords(...args);

  // Alerts and watchlist
  alerts = (...args: Parameters<AlertsRepository["alerts"]>) =>
    this.alertsRepository.alerts(...args);
  customAlertRules = (...args: Parameters<AlertsRepository["customAlertRules"]>) =>
    this.alertsRepository.customAlertRules(...args);
  createCustomAlertRule = (...args: Parameters<AlertsRepository["createCustomAlertRule"]>) =>
    this.alertsRepository.createCustomAlertRule(...args);
  updateCustomAlertRule = (...args: Parameters<AlertsRepository["updateCustomAlertRule"]>) =>
    this.alertsRepository.updateCustomAlertRule(...args);
  deleteCustomAlertRule = (...args: Parameters<AlertsRepository["deleteCustomAlertRule"]>) =>
    this.alertsRepository.deleteCustomAlertRule(...args);
  previewCustomAlertRule = (...args: Parameters<AlertsRepository["previewCustomAlertRule"]>) =>
    this.alertsRepository.previewCustomAlertRule(...args);
  dismissAlert = (...args: Parameters<AlertsRepository["dismissAlert"]>) =>
    this.alertsRepository.dismissAlert(...args);
  dismissAlerts = (...args: Parameters<AlertsRepository["dismissAlerts"]>) =>
    this.alertsRepository.dismissAlerts(...args);
  watchlist = (...args: Parameters<AlertsRepository["watchlist"]>) =>
    this.alertsRepository.watchlist(...args);
  putWatchlist = (...args: Parameters<AlertsRepository["putWatchlist"]>) =>
    this.alertsRepository.putWatchlist(...args);
  deleteWatchlist = (...args: Parameters<AlertsRepository["deleteWatchlist"]>) =>
    this.alertsRepository.deleteWatchlist(...args);

  // Saved views
  savedViews = (...args: Parameters<SavedViewsRepository["savedViews"]>) =>
    this.savedViewsRepository.savedViews(...args);
  createSavedView = (...args: Parameters<SavedViewsRepository["createSavedView"]>) =>
    this.savedViewsRepository.createSavedView(...args);
  updateSavedView = (...args: Parameters<SavedViewsRepository["updateSavedView"]>) =>
    this.savedViewsRepository.updateSavedView(...args);
  deleteSavedView = (...args: Parameters<SavedViewsRepository["deleteSavedView"]>) =>
    this.savedViewsRepository.deleteSavedView(...args);

  // Status
  databaseReady = (...args: Parameters<StatusRepository["databaseReady"]>) =>
    this.status.databaseReady(...args);
  saveReceiverInfo = (...args: Parameters<StatusRepository["saveReceiverInfo"]>) =>
    this.status.saveReceiverInfo(...args);
  receiverInfo = (...args: Parameters<StatusRepository["receiverInfo"]>) =>
    this.status.receiverInfo(...args);
  saveReceiverSample = (...args: Parameters<StatusRepository["saveReceiverSample"]>) =>
    this.status.saveReceiverSample(...args);
  databaseStatus = (...args: Parameters<StatusRepository["databaseStatus"]>) =>
    this.status.databaseStatus(...args);
  metadataStatus = (...args: Parameters<StatusRepository["metadataStatus"]>) =>
    this.status.metadataStatus(...args);
  lastMaintenanceAt = (...args: Parameters<StatusRepository["lastMaintenanceAt"]>) =>
    this.status.lastMaintenanceAt(...args);
}
